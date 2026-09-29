const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('fs'); const os=require('os'); const path=require('path'); const ExcelJS=require('exceljs');
const {buildSuggestions}=require('../suggestions'); const {queryExcelFile,buildWorkbook}=require('../excel');

test('suggestions return approval chip only when signal exists',()=>{assert.deepEqual(buildSuggestions({approvalCount:1,reminderCount:0}),[{label:'Review approval',prompt:'What approvals are waiting for me?'}]);});
test('suggestions return empty when no signals fire',()=>{assert.deepEqual(buildSuggestions({approvalCount:0,reminderCount:0,recentUserCount:0,hour:10}),[]);});
test('suggestions return reminder signal',()=>{assert.equal(buildSuggestions({reminderCount:2})[0].label,'Today’s reminders');});

test('excel query arithmetic is deterministic',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pa-excel-')); const file=path.join(dir,'test.xlsx');
 await buildWorkbook(file,{sheets:[{name:'Sales',headers:['Month','Revenue'],rows:[['Jan',100],['Feb',250],['Mar',50]]}]});
 const sum=await queryExcelFile(file,'test.xlsx','Sales',{sheet:'Sales',operation:'sum',column:'Revenue',filters:[],limit:10});
 assert.equal(sum.value,400); assert.equal(sum.count,3);
 const grouped=await queryExcelFile(file,'test.xlsx','Sales',{sheet:'Sales',operation:'group_by',column:'Revenue',group_by:'Month',filters:[],limit:10});
 assert.equal(grouped.result[0].sum,250);
 fs.rmSync(dir,{recursive:true,force:true});
});
