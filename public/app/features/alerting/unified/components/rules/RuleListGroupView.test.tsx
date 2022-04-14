import { render } from '@testing-library/react';
import { contextSrv } from 'app/core/services/context_srv';
import { configureStore } from 'app/store/configureStore';
import { AccessControlAction } from 'app/types';
import { CombinedRuleNamespace } from 'app/types/unified-alerting';
import React from 'react';
import { Provider } from 'react-redux';
import { byRole } from 'testing-library-selector';
import { mockCombinedRule, mockDataSource } from '../../mocks';
import { GRAFANA_RULES_SOURCE_NAME } from '../../utils/datasource';
import { RuleListGroupView } from './RuleListGroupView';

const ui = {
  grafanaRulesHeading: byRole('heading', { name: 'Grafana' }),
  cloudRulesHeading: byRole('heading', { name: 'Mimir / Cortex / Loki' }),
};

describe('RuleListGroupView', () => {
  describe('FGAC', () => {
    jest.spyOn(contextSrv, 'accessControlEnabled').mockReturnValue(true);

    it('Should display Grafana rules when the user has the alert rule read permission', () => {
      const grafanaNamespace = getGrafanaNamespace();
      const namespaces: CombinedRuleNamespace[] = [grafanaNamespace];

      jest
        .spyOn(contextSrv, 'hasPermission')
        .mockImplementation((action) => action === AccessControlAction.AlertingRuleRead);

      renderRuleList(namespaces);

      expect(ui.grafanaRulesHeading.get()).toBeInTheDocument();
    });

    it('Should display Cloud rules when the user has the external rules read permission', () => {
      const cloudNamespace = getCloudNamespace();
      const namespaces: CombinedRuleNamespace[] = [cloudNamespace];

      jest
        .spyOn(contextSrv, 'hasPermission')
        .mockImplementation((action) => action === AccessControlAction.AlertingRuleExternalRead);

      renderRuleList(namespaces);

      expect(ui.cloudRulesHeading.get()).toBeInTheDocument();
    });

    it('Should not display Grafana rules when the user does not have alert rule read permission', () => {
      const grafanaNamespace = getGrafanaNamespace();
      const namespaces: CombinedRuleNamespace[] = [grafanaNamespace];

      jest.spyOn(contextSrv, 'hasPermission').mockReturnValue(false);

      renderRuleList(namespaces);

      expect(ui.grafanaRulesHeading.query()).not.toBeInTheDocument();
    });

    it('Should not display Cloud rules when the user does not have the external rules read permission', () => {
      const cloudNamespace = getCloudNamespace();

      const namespaces: CombinedRuleNamespace[] = [cloudNamespace];
      renderRuleList(namespaces);

      jest.spyOn(contextSrv, 'hasPermission').mockReturnValue(false);

      renderRuleList(namespaces);

      expect(ui.cloudRulesHeading.query()).not.toBeInTheDocument();
    });
  });
});

function renderRuleList(namespaces: CombinedRuleNamespace[]) {
  const store = configureStore();

  render(
    <Provider store={store}>
      <RuleListGroupView namespaces={namespaces} expandAll />
    </Provider>
  );
}

function getGrafanaNamespace(): CombinedRuleNamespace {
  return {
    name: 'Grafana Test Namespace',
    rulesSource: GRAFANA_RULES_SOURCE_NAME,
    groups: [
      {
        name: 'default',
        rules: [mockCombinedRule()],
      },
    ],
  };
}

function getCloudNamespace(): CombinedRuleNamespace {
  return {
    name: 'Cloud Test Namespace',
    rulesSource: mockDataSource(),
    groups: [
      {
        name: 'Prom group',
        rules: [mockCombinedRule()],
      },
    ],
  };
}