import React, { PureComponent } from 'react';
import { hot } from 'react-hot-loader';
import { connect } from 'react-redux';
import PageHeader from '../../core/components/PageHeader/PageHeader';
import PluginActionBar from './PluginActionBar';
import PluginList from './PluginList';
import { NavModel, Plugin } from '../../types';
import { loadPlugins } from './state/actions';
import { getNavModel } from '../../core/selectors/navModel';
import { getPlugins } from './state/selectors';

interface Props {
  navModel: NavModel;
  plugins: Plugin[];
  loadPlugins: typeof loadPlugins;
}

export class PluginListPage extends PureComponent<Props> {
  componentDidMount() {
    this.fetchPlugins();
  }

  async fetchPlugins() {
    await this.props.loadPlugins();
  }

  render() {
    const { navModel, plugins } = this.props;

    return (
      <div>
        <PageHeader model={navModel} />
        <div className="page-container page-body">
          <PluginActionBar searchQuery="" onQueryChange={() => {}} />
          {plugins && <PluginList plugins={plugins} layout="grid" />}
        </div>
      </div>
    );
  }
}

function mapStateToProps(state) {
  return {
    navModel: getNavModel(state.navIndex, 'plugins'),
    plugins: getPlugins(state.plugins),
  };
}

const mapDispatchToProps = {
  loadPlugins,
};

export default hot(module)(connect(mapStateToProps, mapDispatchToProps)(PluginListPage));
