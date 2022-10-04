import { MutableRefObject } from 'react';
import uPlot from 'uplot';

import {
  DataFrame,
  FieldColorModeId,
  fieldColorModeRegistry,
  getDisplayProcessor,
  getFieldColorModeForField,
  getFieldDisplayName,
  getFieldSeriesColor,
  GrafanaTheme2,
} from '@grafana/data';
import { alpha } from '@grafana/data/src/themes/colorManipulator';
import { config } from '@grafana/runtime';
import { AxisPlacement, ScaleDirection, ScaleOrientation, VisibilityMode } from '@grafana/schema';
import { UPlotConfigBuilder } from '@grafana/ui';
import { FacetedData, FacetSeries } from '@grafana/ui/src/components/uPlot/types';
import {
  findFieldIndex,
  getScaledDimensionForField,
  ScaleDimensionConfig,
  ScaleDimensionMode,
} from 'app/features/dimensions';

import { pointWithin, Quadtree, Rect } from '../barchart/quadtree';

import { isGraphable } from './dims';
import { defaultScatterConfig, ScatterFieldConfig, ScatterShow, XYChartOptions } from './models.gen';
import { DimensionValues, ScatterHoverCallback, ScatterSeries } from './types';

export interface ScatterPanelInfo {
  error?: string;
  series: ScatterSeries[];
  builder?: UPlotConfigBuilder;
}

/**
 * This is called when options or structure rev changes
 */
export function prepScatter(
  options: XYChartOptions,
  getData: () => DataFrame[],
  theme: GrafanaTheme2,
  ttip: ScatterHoverCallback,
  onUPlotClick: null | ((evt?: Object) => void),
  isToolTipOpen: MutableRefObject<boolean>
): ScatterPanelInfo {
  let series: ScatterSeries[];
  let builder: UPlotConfigBuilder;

  try {
    series = prepSeries(options, getData());
    builder = prepConfig(getData, series, theme, ttip, onUPlotClick, isToolTipOpen);
  } catch (e) {
    let errorMsg = 'Unknown error in prepScatter';
    if (typeof e === 'string') {
      errorMsg = e;
    } else if (e instanceof Error) {
      errorMsg = e.message;
    }

    return {
      error: errorMsg,
      series: [],
    };
  }

  return {
    series,
    builder,
  };
}

interface Dims {
  pointColorIndex?: number;
  pointColorFixed?: string;

  pointSizeIndex?: number;
  pointSizeConfig?: ScaleDimensionConfig;
}

function getScatterSeries(
  seriesIndex: number,
  frames: DataFrame[],
  frameIndex: number,
  xIndex: number,
  yIndex: number,
  dims: Dims
): ScatterSeries {
  const frame = frames[frameIndex];
  const y = frame.fields[yIndex];
  const state = y.state ?? {};
  state.seriesIndex = seriesIndex;
  y.state = state;

  // Color configs
  //----------------
  let seriesColor = dims.pointColorFixed
    ? config.theme2.visualization.getColorByName(dims.pointColorFixed)
    : getFieldSeriesColor(y, config.theme2).color;
  let pointColor: DimensionValues<string> = () => seriesColor;
  const fieldConfig: ScatterFieldConfig = { ...defaultScatterConfig, ...y.config.custom };
  let pointColorMode = fieldColorModeRegistry.get(FieldColorModeId.PaletteClassic);
  if (dims.pointColorIndex) {
    const f = frames[frameIndex].fields[dims.pointColorIndex];
    if (f) {
      const disp =
        f.display ??
        getDisplayProcessor({
          field: f,
          theme: config.theme2,
        });
      pointColorMode = getFieldColorModeForField(y);
      if (pointColorMode.isByValue) {
        const index = dims.pointColorIndex;
        pointColor = (frame: DataFrame) => {
          // Yes we can improve this later
          return frame.fields[index].values.toArray().map((v) => disp(v).color!);
        };
      } else {
        seriesColor = pointColorMode.getCalculator(f, config.theme2)(f.values.get(0), 1);
        pointColor = () => seriesColor;
      }
    }
  }

  // Size configs
  //----------------
  let pointSizeHints = dims.pointSizeConfig;
  const pointSizeFixed = dims.pointSizeConfig?.fixed ?? y.config.custom?.pointSize?.fixed ?? 5;
  let pointSize: DimensionValues<number> = () => pointSizeFixed;
  if (dims.pointSizeIndex) {
    pointSize = (frame) => {
      const s = getScaledDimensionForField(
        frame.fields[dims.pointSizeIndex!],
        dims.pointSizeConfig!,
        ScaleDimensionMode.Quadratic
      );
      const vals = Array(frame.length);
      for (let i = 0; i < frame.length; i++) {
        vals[i] = s.get(i);
      }
      return vals;
    };
  } else {
    pointSizeHints = {
      fixed: pointSizeFixed,
      min: pointSizeFixed,
      max: pointSizeFixed,
    };
  }

  // Series config
  //----------------
  const name = getFieldDisplayName(y, frame, frames);
  return {
    name,

    frame: (frames) => frames[frameIndex],

    x: (frame) => frame.fields[xIndex],
    y: (frame) => frame.fields[yIndex],
    legend: () => {
      return [
        {
          label: name,
          color: seriesColor, // single color for series?
          getItemKey: () => name,
          yAxis: yIndex, // << but not used
        },
      ];
    },

    showLine: fieldConfig.show !== ScatterShow.Points,
    lineWidth: fieldConfig.lineWidth ?? 2,
    lineStyle: fieldConfig.lineStyle!,
    lineColor: () => seriesColor,

    showPoints: fieldConfig.show !== ScatterShow.Lines ? VisibilityMode.Always : VisibilityMode.Never,
    pointSize,
    pointColor,
    pointSymbol: (frame: DataFrame, from?: number) => 'circle', // single field, multiple symbols.... kinda equals multiple series 🤔

    label: VisibilityMode.Never,
    labelValue: () => '',
    show: !frame.fields[yIndex].config.custom.hideFrom?.viz,

    hints: {
      pointSize: pointSizeHints!,
      pointColor: {
        mode: pointColorMode,
      },
    },
  };
}

function prepSeries(options: XYChartOptions, frames: DataFrame[]): ScatterSeries[] {
  let seriesIndex = 0;
  if (!frames.length) {
    throw 'Missing data';
  }

  if (options.seriesMapping === 'manual') {
    if (!options.series?.length) {
      throw 'Missing series config';
    }

    const scatterSeries: ScatterSeries[] = [];

    for (const series of options.series) {
      if (!series?.x) {
        throw 'Select X dimension';
      }

      if (!series?.y) {
        throw 'Select Y dimension';
      }

      for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
        const frame = frames[frameIndex];
        const xIndex = findFieldIndex(frame, series.x);

        if (xIndex != null) {
          // TODO: this should find multiple y fields
          const yIndex = findFieldIndex(frame, series.y);

          if (yIndex == null) {
            throw 'Y must be in the same frame as X';
          }

          const dims: Dims = {
            pointColorFixed: series.pointColor?.fixed,
            pointColorIndex: findFieldIndex(frame, series.pointColor?.field),
            pointSizeConfig: series.pointSize,
            pointSizeIndex: findFieldIndex(frame, series.pointSize?.field),
          };
          scatterSeries.push(getScatterSeries(seriesIndex++, frames, frameIndex, xIndex, yIndex, dims));
        }
      }
    }

    return scatterSeries;
  }

  // Default behavior
  const dims = options.dims ?? {};
  const frameIndex = dims.frame ?? 0;
  const frame = frames[frameIndex];
  const numericIndices: number[] = [];

  let xIndex = findFieldIndex(frame, dims.x);
  for (let i = 0; i < frame.fields.length; i++) {
    if (isGraphable(frame.fields[i])) {
      if (xIndex == null || i === xIndex) {
        xIndex = i;
        continue;
      }
      if (dims.exclude && dims.exclude.includes(getFieldDisplayName(frame.fields[i], frame, frames))) {
        continue; // skip
      }

      numericIndices.push(i);
    }
  }

  if (xIndex == null) {
    throw 'Missing X dimension';
  }

  if (!numericIndices.length) {
    throw 'No Y values';
  }
  return numericIndices.map((yIndex) => getScatterSeries(seriesIndex++, frames, frameIndex, xIndex!, yIndex, {}));
}

interface DrawBubblesOpts {
  each: (u: uPlot, seriesIdx: number, dataIdx: number, lft: number, top: number, wid: number, hgt: number) => void;
  disp: {
    //unit: 3,
    size: {
      values: (u: uPlot, seriesIdx: number) => number[];
    };
    color: {
      values: (u: uPlot, seriesIdx: number) => string[];
      alpha: (u: uPlot, seriesIdx: number) => string[];
    };
  };
}

//const prepConfig: UPlotConfigPrepFnXY<XYChartOptions> = ({ frames, series, theme }) => {
const prepConfig = (
  getData: () => DataFrame[],
  scatterSeries: ScatterSeries[],
  theme: GrafanaTheme2,
  ttip: ScatterHoverCallback,
  onUPlotClick: null | ((evt?: Object) => void),
  isToolTipOpen: MutableRefObject<boolean>
) => {
  let qt: Quadtree;
  let hRect: Rect | null;

  function drawBubblesFactory(opts: DrawBubblesOpts) {
    const drawBubbles: uPlot.Series.PathBuilder = (u, seriesIdx, idx0, idx1) => {
      uPlot.orient(
        u,
        seriesIdx,
        (
          series,
          dataX,
          dataY,
          scaleX,
          scaleY,
          valToPosX,
          valToPosY,
          xOff,
          yOff,
          xDim,
          yDim,
          moveTo,
          lineTo,
          rect,
          arc
        ) => {
          const scatterInfo = scatterSeries[seriesIdx - 1];
          const d = u.data[seriesIdx] as unknown as FacetSeries;

          let showLine = scatterInfo.showLine;
          let showPoints = scatterInfo.showPoints === VisibilityMode.Always;
          if (!showPoints && scatterInfo.showPoints === VisibilityMode.Auto) {
            showPoints = d[0].length < 1000;
          }

          // always show something
          if (!showPoints && !showLine) {
            showLine = true;
          }

          const strokeWidth = 1;

          u.ctx.save();

          u.ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
          u.ctx.clip();

          u.ctx.fillStyle = (series.fill as any)(); // assumes constant
          u.ctx.strokeStyle = (series.stroke as any)();
          u.ctx.lineWidth = strokeWidth;

          const deg360 = 2 * Math.PI;

          const xKey = scaleX.key!;
          const yKey = scaleY.key!;

          const pointHints = scatterInfo.hints.pointSize;
          const colorByValue = scatterInfo.hints.pointColor.mode.isByValue;

          const maxSize = (pointHints.max ?? pointHints.fixed) * devicePixelRatio;

          // todo: this depends on direction & orientation
          // todo: calc once per redraw, not per path
          const filtLft = u.posToVal(-maxSize / 2, xKey);
          const filtRgt = u.posToVal(u.bbox.width / devicePixelRatio + maxSize / 2, xKey);
          const filtBtm = u.posToVal(u.bbox.height / devicePixelRatio + maxSize / 2, yKey);
          const filtTop = u.posToVal(-maxSize / 2, yKey);

          const sizes = opts.disp.size.values(u, seriesIdx);
          const pointColors = opts.disp.color.values(u, seriesIdx);
          const pointAlpha = opts.disp.color.alpha(u, seriesIdx);

          const linePath: Path2D | null = showLine ? new Path2D() : null;

          for (let i = 0; i < d[0].length; i++) {
            const xVal = d[0][i];
            const yVal = d[1][i];
            const size = sizes[i] * devicePixelRatio;

            if (xVal >= filtLft && xVal <= filtRgt && yVal >= filtBtm && yVal <= filtTop) {
              const cx = valToPosX(xVal, scaleX, xDim, xOff);
              const cy = valToPosY(yVal, scaleY, yDim, yOff);

              if (showLine) {
                linePath!.lineTo(cx, cy);
              }

              if (showPoints) {
                u.ctx.moveTo(cx + size / 2, cy);
                u.ctx.beginPath();
                u.ctx.arc(cx, cy, size / 2, 0, deg360);

                if (colorByValue) {
                  u.ctx.fillStyle = pointAlpha[i];
                  u.ctx.strokeStyle = pointColors[i];
                }

                u.ctx.fill();
                u.ctx.stroke();
                opts.each(
                  u,
                  seriesIdx,
                  i,
                  cx - size / 2 - strokeWidth / 2,
                  cy - size / 2 - strokeWidth / 2,
                  size + strokeWidth,
                  size + strokeWidth
                );
              }
            }
          }

          if (showLine) {
            const frame = scatterInfo.frame(getData());
            u.ctx.strokeStyle = scatterInfo.lineColor(frame);
            u.ctx.lineWidth = scatterInfo.lineWidth * devicePixelRatio;

            const { lineStyle } = scatterInfo;
            if (lineStyle && lineStyle.fill !== 'solid') {
              if (lineStyle.fill === 'dot') {
                u.ctx.lineCap = 'round';
              }
              u.ctx.setLineDash(lineStyle.dash ?? [10, 10]);
            }

            u.ctx.stroke(linePath!);
          }

          u.ctx.restore();
        }
      );

      return null;
    };

    return drawBubbles;
  }

  const drawBubbles = drawBubblesFactory({
    disp: {
      size: {
        //unit: 3, // raw CSS pixels
        values: (u, seriesIdx) => {
          return u.data[seriesIdx][2] as any; // already contains final pixel geometry
          //let [minValue, maxValue] = getSizeMinMax(u);
          //return u.data[seriesIdx][2].map(v => getSize(v, minValue, maxValue));
        },
      },
      color: {
        // string values
        values: (u, seriesIdx) => {
          return u.data[seriesIdx][3] as any;
        },
        alpha: (u, seriesIdx) => {
          return u.data[seriesIdx][4] as any;
        },
      },
    },
    each: (u, seriesIdx, dataIdx, lft, top, wid, hgt) => {
      // we get back raw canvas coords (included axes & padding). translate to the plotting area origin
      lft -= u.bbox.left;
      top -= u.bbox.top;
      qt.add({ x: lft, y: top, w: wid, h: hgt, sidx: seriesIdx, didx: dataIdx });
    },
  });

  const builder = new UPlotConfigBuilder();

  builder.setCursor({
    drag: { setScale: true },
    dataIdx: (u, seriesIdx) => {
      if (seriesIdx === 1) {
        hRect = null;

        let dist = Infinity;
        const cx = u.cursor.left! * devicePixelRatio;
        const cy = u.cursor.top! * devicePixelRatio;

        qt.get(cx, cy, 1, 1, (o) => {
          if (pointWithin(cx, cy, o.x, o.y, o.x + o.w, o.y + o.h)) {
            const ocx = o.x + o.w / 2;
            const ocy = o.y + o.h / 2;

            const dx = ocx - cx;
            const dy = ocy - cy;

            const d = Math.sqrt(dx ** 2 + dy ** 2);

            // test against radius for actual hover
            if (d <= o.w / 2) {
              // only hover bbox with closest distance
              if (d <= dist) {
                dist = d;
                hRect = o;
              }
            }
          }
        });
      }

      return hRect && seriesIdx === hRect.sidx ? hRect.didx : null;
    },
    points: {
      size: (u, seriesIdx) => {
        return hRect && seriesIdx === hRect.sidx ? hRect.w / devicePixelRatio : 0;
      },
      fill: (u, seriesIdx) => 'rgba(255,255,255,0.4)',
    },
  });

  const clearPopupIfOpened = () => {
    if (isToolTipOpen.current) {
      ttip(undefined);
      if (onUPlotClick) {
        onUPlotClick();
      }
    }
  };

  let ref_parent: HTMLElement | null = null;

  // clip hover points/bubbles to plotting area
  builder.addHook('init', (u, r) => {
    u.over.style.overflow = 'hidden';
    ref_parent = u.root.parentElement;

    if (onUPlotClick) {
      ref_parent?.addEventListener('click', onUPlotClick);
    }
  });

  builder.addHook('destroy', (u) => {
    if (onUPlotClick) {
      ref_parent?.removeEventListener('click', onUPlotClick);
      clearPopupIfOpened();
    }
  });

  let rect: DOMRect;

  // rect of .u-over (grid area)
  builder.addHook('syncRect', (u, r) => {
    rect = r;
  });

  builder.addHook('setLegend', (u) => {
    if (u.cursor.idxs != null) {
      for (let i = 0; i < u.cursor.idxs.length; i++) {
        const sel = u.cursor.idxs[i];
        if (sel != null && !isToolTipOpen.current) {
          ttip({
            scatterIndex: i - 1,
            xIndex: sel,
            pageX: rect.left + u.cursor.left!,
            pageY: rect.top + u.cursor.top!,
          });
          return; // only show the first one
        }
      }
    }

    if (!isToolTipOpen.current) {
      ttip(undefined);
    }
  });

  builder.addHook('drawClear', (u) => {
    clearPopupIfOpened();

    qt = qt || new Quadtree(0, 0, u.bbox.width, u.bbox.height);

    qt.clear();

    // force-clear the path cache to cause drawBars() to rebuild new quadtree
    u.series.forEach((s, i) => {
      if (i > 0) {
        // @ts-ignore
        s._paths = null;
      }
    });
  });

  builder.setMode(2);

  const frames = getData();
  const xField = scatterSeries[0].x(scatterSeries[0].frame(frames));

  builder.addScale({
    scaleKey: 'x',
    isTime: false,
    orientation: ScaleOrientation.Horizontal,
    direction: ScaleDirection.Right,
    range: (u, min, max) => [min, max],
  });

  // why does this fall back to '' instead of null or undef?
  const xAxisLabel = xField.config.custom.axisLabel;

  builder.addAxis({
    scaleKey: 'x',
    placement:
      xField.config.custom?.axisPlacement !== AxisPlacement.Hidden ? AxisPlacement.Bottom : AxisPlacement.Hidden,
    show: xField.config.custom?.axisPlacement !== AxisPlacement.Hidden,
    theme,
    label:
      xAxisLabel == null || xAxisLabel === ''
        ? getFieldDisplayName(xField, scatterSeries[0].frame(frames), frames)
        : xAxisLabel,
  });

  scatterSeries.forEach((s, si) => {
    const frame = s.frame(frames);
    const field = s.y(frame);

    const lineColor = s.lineColor(frame);
    const pointColor = asSingleValue(frame, s.pointColor) as string;
    //const lineColor = s.lineColor(frame);
    //const lineWidth = s.lineWidth;

    const scaleKey = field.config.unit ?? 'y';

    builder.addScale({
      scaleKey,
      orientation: ScaleOrientation.Vertical,
      direction: ScaleDirection.Up,
      range: (u, min, max) => [min, max],
    });

    if (field.config.custom?.axisPlacement !== AxisPlacement.Hidden) {
      // why does this fall back to '' instead of null or undef?
      const yAxisLabel = field.config.custom?.axisLabel;

      builder.addAxis({
        scaleKey,
        theme,
        placement: field.config.custom?.axisPlacement,
        label:
          yAxisLabel == null || yAxisLabel === ''
            ? getFieldDisplayName(field, scatterSeries[si].frame(frames), frames)
            : yAxisLabel,
        values: (u, splits) => splits.map((s) => field.display!(s).text),
      });
    }

    builder.addSeries({
      facets: [
        {
          scale: 'x',
          auto: true,
        },
        {
          scale: scaleKey,
          auto: true,
        },
      ],
      pathBuilder: drawBubbles, // drawBubbles({disp: {size: {values: () => }}})
      theme,
      scaleKey: '', // facets' scales used (above)
      lineColor: lineColor as string,
      fillColor: alpha(pointColor, 0.5),
      show: !field.config.custom.hideFrom?.viz,
    });
  });

  /*
  builder.setPrepData((frames) => {
    let seriesData = lookup.fieldMaps.flatMap((f, i) => {
      let { fields } = frames[i];

      return f.y.map((yIndex, frameSeriesIndex) => {
        let xValues = fields[f.x[frameSeriesIndex]].values.toArray();
        let yValues = fields[f.y[frameSeriesIndex]].values.toArray();
        let sizeValues = f.size![frameSeriesIndex](frames[i]);

        if (!Array.isArray(sizeValues)) {
          sizeValues = Array(xValues.length).fill(sizeValues);
        }

        return [xValues, yValues, sizeValues];
      });
    });

    return [null, ...seriesData];
  });
  */

  return builder;
};

/**
 * This is called everytime the data changes
 *
 * from?  is this where we would support that?  -- need the previous values
 */
export function prepData(info: ScatterPanelInfo, data: DataFrame[], from?: number): FacetedData {
  if (info.error || !data.length) {
    return [null];
  }
  return [
    null,
    ...info.series.map((s, idx) => {
      const frame = s.frame(data);

      let colorValues;
      let colorAlphaValues;
      const r = s.pointColor(frame);
      if (Array.isArray(r)) {
        colorValues = r;
        colorAlphaValues = r.map((c) => alpha(c as string, 0.5));
      } else {
        colorValues = Array(frame.length).fill(r);
        colorAlphaValues = Array(frame.length).fill(alpha(r as string, 0.5));
      }
      return [
        s.x(frame).values.toArray(), // X
        s.y(frame).values.toArray(), // Y
        asArray(frame, s.pointSize),
        colorValues,
        colorAlphaValues,
      ];
    }),
  ];
}

function asArray<T>(frame: DataFrame, lookup: DimensionValues<T>): T[] {
  const r = lookup(frame);
  if (Array.isArray(r)) {
    return r;
  }
  return Array(frame.length).fill(r);
}

function asSingleValue<T>(frame: DataFrame, lookup: DimensionValues<T>): T {
  const r = lookup(frame);
  if (Array.isArray(r)) {
    return r[0];
  }
  return r;
}
