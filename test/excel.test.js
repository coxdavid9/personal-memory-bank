const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('fs'); const os=require('os'); const path=require('path'); const ExcelJS=require('exceljs');
const {buildSuggestions}=require('../suggestions'); const {queryExcelFile,buildWorkbook}=require('../excel');

test('suggestions return approval chip only when signal exists',()=>{assert.deepEqual(buildSuggestions({approvalCount:1,reminderCount:0}),[{label:'Review approval',prompt:'What approvals are waiting for me?'}]);});
test('suggestions return empty when no signals fire',()=>{assert.deepEqual(buildSuggestions({approvalCount:0,reminderCount:0,recentUserCount:0,hour:10}),[]);});
test('suggestions return reminder signal',()=>{assert.equal(buildSuggestions({reminderCount:2})[0].label,'Today’s tasks');});


test('excel query performs deterministic arithmetic', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pa-excel-'));
  const file=path.join(dir,'sample.xlsx');
  const wb=new ExcelJS.Workbook();
  const ws=wb.addWorksheet('Data');
  ws.addRow(['Month','Revenue']);
  ws.addRow(['Jan',100]);
  ws.addRow(['Feb',250]);
  ws.addRow(['Mar',150]);
  await wb.xlsx.writeFile(file);
  const result=await queryExcelFile(file,'sample.xlsx',{sheet:'Data',operation:'sum',column:'Revenue',filters:[],limit:10});
  assert.equal(result.value,500);
  const grouped=await queryExcelFile(file,'sample.xlsx',{sheet:'Data',operation:'group_by',column:'Revenue',group_by:'Month',filters:[],limit:10});
  assert.equal(grouped.result.length,3);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('excel workbook generation creates a readable xlsx', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pa-build-'));
  const file=path.join(dir,'output.xlsx');
  await buildWorkbook(file,{sheets:[{name:'Summary',headers:['Metric','Value'],rows:[['Revenue',500],['Margin',0.32]]}]});
  const stat=fs.statSync(file); assert.ok(stat.size>0);
  const wb=new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
  assert.equal(wb.getWorksheet('Summary').getCell('A2').value,'Revenue');
  assert.equal(wb.getWorksheet('Summary').getCell('B2').value,500);
  fs.rmSync(dir,{recursive:true,force:true});
});
