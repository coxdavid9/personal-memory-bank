const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildAgentTools, executeAgentTool } = require('../agent-tools');
const { buildToolDeps } = require('../server');

function fakePool() {
  return {
    query: async (sql) => {
      if (/INSERT INTO memories/.test(sql)) return { rows: [{ id: 1, created: new Date(), text: 'test', type: 'Work', due: null, priority: 'Normal', done: false }] };
      return { rows: [] };
    }
  };
}

function toolArgs(name) {
  const args = {
    save_memory: { text: 'approval deps test', type: 'Work', due: null, priority: 'Normal' },
    get_personal_context: {},
    get_portfolio_summary: {},
    record_holding: { account: 'Test', ticker: 'VOO', shares: 1, balance: null },
    delete_holding: { holding_id: 1, delete_all_manual: false },
    get_job_application_history: {},
    save_job_application: { title: 'Test Accountant', company: 'Test Co', location: 'Jonesboro, AR', url: null, status: 'saved', notes: null },
    create_calendar_event: { title: 'Test', start: '2026-09-29T14:00:00-05:00', end: '2026-09-29T15:00:00-05:00', notes: null, location: null, allDay: false },
    delegate_to_team: { role: 'engineering', task: 'Test approval deps', project: 'Personal Agent', context: null },
    excel_summary: { file_id: 1 },
    excel_query: { file_id: 1, sheet: 'Sheet1', operation: 'sum', column: 'Amount', group_by: null, limit: 10, filters: [] },
    excel_build: { name: 'approval-deps-test.xlsx', sheets: [{ name: 'Sheet1', headers: ['A'], rows: [['x']] }] },
    excel_delete: { file_id: 1 }
  };
  return args[name] || {};
}

function mockedDeps(overrides = {}) {
  return buildToolDeps({
    actions: [],
    runId: 'approval-test',
    skipPolicy: true,
    overrides: {
      pool: fakePool(),
      getAgentContext: async () => ({ memories: [], projects: [], capabilities: [], portfolioState: { manualCount: 0, plaidCount: 0 } }),
      recordHolding: async () => ({ ok: true }),
      deleteHolding: async () => ({ ok: true }),
      deleteManualHoldings: async () => ({ ok: true, deleted: 0 }),
      getPortfolioSummary: async () => ({}),
      getJobApplicationHistory: async () => [],
      saveJobApplication: async () => ({ ok: true }),
      delegateToTeam: async () => ({ ok: true }),
      callSpecialist: async () => 'ok',
      getExcelFile: async () => null,
      profileExcelFile: async () => ({}),
      queryExcelFile: async () => ({}),
      deleteExcelFile: async () => ({ ok: true }),
      createExcelFile: async () => ({ id: 1, name: 'approval-deps-test.xlsx' }),
      buildExcelWorkbook: async (filePath) => { await fs.writeFile(filePath, 'test'); },
      excelUploadDir: os.tmpdir(),
      ...overrides
    }
  });
}

test('approval deps cover every registered function tool without missing-function TypeErrors', async () => {
  const names = [...new Set(
    ['general', 'excel_analysis', 'job_search', 'portfolio', 'calendar', 'engineering', 'business', 'product']
      .flatMap(job => buildAgentTools({ job }).filter(tool => tool.type === 'function').map(tool => tool.name))
  )];

  for (const name of names) {
    const deps = mockedDeps();
    try {
      await executeAgentTool(name, toolArgs(name), deps);
    } catch (err) {
      assert.ok(
        !(err instanceof TypeError && /deps\\.\\w+ is not a function/.test(err.message)),
        `${name} hit a missing dependency: ${err.message}`
      );
    }
  }
});

test('approval deps explicitly include job application and holding executors', async () => {
  const calls = [];
  const deps = mockedDeps({
    getJobApplicationHistory: async () => { calls.push('get_job_application_history'); return []; },
    saveJobApplication: async () => { calls.push('save_job_application'); return { ok: true }; },
    deleteHolding: async () => { calls.push('delete_holding'); return { ok: true }; }
  });

  await executeAgentTool('get_job_application_history', {}, deps);
  await executeAgentTool('save_job_application', toolArgs('save_job_application'), deps);
  await executeAgentTool('delete_holding', toolArgs('delete_holding'), deps);

  assert.deepEqual(calls, ['get_job_application_history', 'save_job_application', 'delete_holding']);
});
