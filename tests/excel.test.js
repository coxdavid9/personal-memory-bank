const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE, MAX_TOTAL_BYTES, queryExcelFile, buildWorkbook, profileFile } = require('../excel');
const { classifySkill, TIERS } = require('../policy');
const { inferJob, buildAgentTools } = require('../agent-tools');

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
