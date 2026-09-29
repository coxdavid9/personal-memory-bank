const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('fs'); const os=require('os'); const path=require('path'); const ExcelJS=require('exceljs');
const {buildSuggestions}=require('../suggestions'); const {queryExcelFile,buildWorkbook}=require('../excel');

test('suggestions return approval chip only when signal exists',()=>{assert.deepEqual(buildSuggestions({approvalCount:1,reminderCount:0}),[{label:'Review approval',prompt:'What approvals are waiting for me?'}]);});
test('suggestions return empty when no signals fire',()=>{assert.deepEqual(buildSuggestions({approvalCount:0,reminderCount:0,recentUserCount:0,hour:10}),[]);});
test('suggestions return reminder signal',()=>{assert.equal(buildSuggestions({reminderCount:2})[0].label,'Today’s reminders');});

