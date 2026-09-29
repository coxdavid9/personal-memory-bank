const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE, MAX_TOTAL_BYTES, queryExcelFile, buildWorkbook, profileFile } = require('../excel');
const { classifySkill, TIERS } = require('../policy');
const { inferJob, buildAgentTools, executeAgentTool } = require('../agent-tools');


function assertTypedSchema(node, pathLabel = 'schema') {
  assert.equal(node && typeof node === 'object' && !Array.isArray(node), true, `${pathLabel} must be an object`);
  assert.ok(Object.prototype.hasOwnProperty.call(node, 'type'), `${pathLabel} is missing type`);

  if (node.properties) {
    assert.ok(Array.isArray(node.required), `${pathLabel} is missing required`);
    for (const key of Object.keys(node.properties)) {
      assert.ok(node.required.includes(key), `${pathLabel}.required is missing ${key}`);
    }
    for (const [key, child] of Object.entries(node.properties)) {
      assertTypedSchema(child, `${pathLabel}.properties.${key}`);
    }
  }
  if (node.items) {
    assertTypedSchema(node.items, `${pathLabel}.items`);
  }
}

test('all strict tool parameter schema nodes declare a type', () => {
  const tools = buildAgentTools({ job: 'excel_analysis' }).filter(tool => tool.parameters);
  for (const tool of tools) {
    assertTypedSchema(tool.parameters, `${tool.name}.parameters`);
  }
});

test('Excel upload limits are 25 MB per file, 5 files, 100 MB total', () => {
  assert.equal(MAX_FILE_BYTES, 25 * 1024 * 1024);
  assert.equal(MAX_FILES_PER_MESSAGE, 5);
  assert.equal(MAX_TOTAL_BYTES, 100 * 1024 * 1024);
});

test('Excel tools use the intended policy tiers', () => {
  assert.equal(classifySkill('excel_summary').tier, TIERS.SAFE);
  assert.equal(classifySkill('excel_query').tier, TIERS.SAFE);
  assert.equal(classifySkill('excel_build').tier, TIERS.MONITOR);
  assert.equal(classifySkill('excel_delete').tier, TIERS.ASK);
});

test('Excel files route the agent to the Excel skill', () => {
  const jobWorkbookPrompt = 'Create an Excel workbook of my job applications';
  assert.equal(inferJob(jobWorkbookPrompt), 'excel_analysis');
  const jobWorkbookTools = buildAgentTools({ job: 'excel_analysis' }).map(tool => tool.name);
  assert.ok(jobWorkbookTools.includes('excel_build'));
  assert.ok(jobWorkbookTools.includes('get_job_application_history'));
  assert.ok(jobWorkbookTools.includes('get_portfolio_summary'));
  assert.equal(inferJob('what is in this file?', true), 'excel_analysis');
  const names = buildAgentTools({ job: 'excel_analysis' }).map(tool => tool.name);
  assert.ok(names.includes('excel_summary'));
  assert.ok(names.includes('excel_query'));
  assert.ok(names.includes('excel_build'));
  assert.ok(names.includes('excel_delete'));
});

test('Excel query arithmetic is deterministic and missing values are not treated as zero', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-agent-excel-'));
  const file = path.join(dir, 'sample.xlsx');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.addRow(['Month', 'Revenue', 'Region']);
  ws.addRow(['Jan', 100, 'East']);
  ws.addRow(['Feb', null, 'East']);
  ws.addRow(['Mar', 300, 'West']);
  await wb.xlsx.writeFile(file);
  const sum = await queryExcelFile(file, 'sample.xlsx', { sheet:'Data', operation:'sum', column:'Revenue', filters:[], limit:10 });
  assert.equal(sum.value, 400);
  const grouped = await queryExcelFile(file, 'sample.xlsx', { sheet:'Data', operation:'group_by', column:'Revenue', group_by:'Region', filters:[], limit:10 });
  assert.equal(grouped.result[0].sum, 300);
  const profile = await profileFile(file, 'sample.xlsx');
  assert.equal(profile.sheets[0].rows, 3);
  fs.rmSync(dir, { recursive:true, force:true });
});

test('Generated workbook is a real XLSX with multiple sheets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-agent-build-'));
  const file = path.join(dir, 'generated.xlsx');
  await buildWorkbook(file, {
    sheets: [
      { name:'Summary', headers:['Metric','Value'], rows:[['Revenue',400],['Rows',3]] },
      { name:'Detail', headers:['Month','Revenue'], rows:[['Jan',100],['Mar',300]] }
    ]
  });
  const stat = fs.statSync(file);
  assert.ok(stat.size > 0);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  assert.deepEqual(wb.worksheets.map(s => s.name), ['Summary','Detail']);
  assert.equal(wb.getWorksheet('Summary').getCell('B2').value, 400);
  fs.rmSync(dir, { recursive:true, force:true });
});


test('excel_build executor wiring creates a generated workbook action', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-agent-excel-executor-'));
  const actions = [];
  try {
    const result = await executeAgentTool('excel_build', {
      name: 'job-applications',
      sheets: [
        { name: 'Applications', headers: ['Company','Status'], rows: [['Nestlé','Applied'],['AerCap','Applied']] }
      ]
    }, {
      pool: {},
      excelUploadDir: dir,
      skipPolicy: true,
      buildExcelWorkbook: async (outputPath, spec) => buildWorkbook(outputPath, spec),
      createExcelFile: async (pool, input) => ({
        id: 123,
        name: input.name,
        size_bytes: input.sizeBytes,
        kind: input.kind
      }),
      onAction: action => actions.push(action)
    });
    assert.equal(result.ok, true);
    assert.equal(result.file.id, 123);
    assert.equal(result.action.type, 'file_download');
    assert.equal(result.action.fileId, 123);
    assert.equal(result.action.name, 'job-applications.xlsx');
    assert.equal(actions.length, 1);
    assert.deepEqual(actions[0], result.action);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
