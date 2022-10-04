// Safari < 14 does not have mql.addEventListener(), but uses the old spec mql.addListener()

const oMatchMedia = window.matchMedia;

type MqlListener = (this: MediaQueryList, ev: MediaQueryListEvent) => any;

window.matchMedia = (mediaQueryString) => {
  const mql = oMatchMedia(mediaQueryString);

  if (!mql.addEventListener) {
    // @ts-ignore
    mql.addEventListener = (type: string, listener: MqlListener) => {
      mql.addListener(listener);
    };
    // @ts-ignore
    mql.removeEventListener = (type: string, listener: MqlListener) => {
      mql.removeListener(listener);
    };
  }

  return mql;
};
