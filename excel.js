const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');
const ExcelJS = require('exceljs');

const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 5;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function safeFileName(name) {
  return path.basename(String(name || 'upload')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'upload';
}

function isSpreadsheetName(name) {
  return /\.(xlsx|xls|csv)$/i.test(String(name || ''));
}

function isImageName(name) {
  return /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(String(name || ''));
}

function sniffMime(filePath, name) {
  const fd = fs.openSync(filePath, 'r');
  const head = Buffer.alloc(16);
  try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  const ext = path.extname(name).toLowerCase();
  if (head[0] === 0x50 && head[1] === 0x4b) return 'application/zip';
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return 'application/x-ole-storage';
  const ascii = head.toString('utf8').replace(/\0/g, '');
  if (/^\\?\/?(?:#!)?/.test(ascii) || /^[\x09\x0a\x0d\x20-\x7e]*$/.test(ascii)) {
    if (ext === '.csv') return 'text/csv';
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head.toString('ascii', 0, 6) === 'GIF87a' || head.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

function validateSpreadsheetMime(filePath, name) {
  const ext = path.extname(name).toLowerCase();
  const mime = sniffMime(filePath, name);
  if (ext === '.xlsx' && mime !== 'application/zip') throw new Error(`"${name}" is not a valid XLSX file.`);
  if (ext === '.xls' && mime !== 'application/x-ole-storage') throw new Error(`"${name}" is not a valid legacy XLS file.`);
  if (ext === '.csv' && mime !== 'text/csv') throw new Error(`"${name}" is not a valid CSV file.`);
  if (ext === '.xls') throw new Error(`"${name}" is a legacy .xls file. Please save it as .xlsx and upload it again; the V1 parser uses ExcelJS.`);
  return mime;
}

function normalizeCell(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (value.result != null) return normalizeCell(value.result);
    if (value.text != null) return String(value.text);
    return JSON.stringify(value);
  }
  return value;
}

function detectType(values) {
  const nonEmpty = values.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
  if (!nonEmpty.length) return 'empty';
  if (nonEmpty.every(v => typeof v === 'number' && Number.isFinite(v))) return 'number';
  if (nonEmpty.every(v => v instanceof Date || (!Number.isNaN(Date.parse(String(v))) && /[-/]/.test(String(v))))) return 'date';
  if (nonEmpty.every(v => typeof v === 'boolean' || /^(true|false)$/i.test(String(v)))) return 'boolean';
  return 'text';
}

async function profileXlsx(filePath) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, { entries: 'emit', sharedStrings: 'cache', hyperlinks: 'ignore', worksheets: 'emit' });
  const sheets = [];
  for await (const worksheet of reader) {
    let header = null;
    let headerRow = null;
    let rows = 0;
    const samplesByColumn = [];
    const sample = [];
    for await (const row of worksheet) {
      const vals = row.values.slice(1).map(normalizeCell);
      if (!header && vals.some(v => v !== null && String(v).trim() !== '')) {
        header = vals.map((v, i) => String(v ?? `Column ${i + 1}`).trim() || `Column ${i + 1}`);
        headerRow = row.number;
        header.forEach(() => samplesByColumn.push([]));
      } else if (header) {
        rows += 1;
        if (sample.length < 3) {
          const obj = {};
          header.forEach((name, i) => { obj[name] = vals[i] ?? null; });
          sample.push(obj);
        }
        if (rows <= 200) header.forEach((_, i) => samplesByColumn[i].push(vals[i] ?? null));
      }
    }
    const columns = (header || []).map((name, i) => ({ name, type: detectType(samplesByColumn[i] || []) }));
    sheets.push({ name: worksheet.name, rows, dimensions: { rows: rows + (headerRow ? 1 : 0), columns: (header || []).length }, header_row: headerRow, columns, sample });
  }
  return { sheets, total_rows: sheets.reduce((n, s) => n + s.rows, 0) };
}
function splitCsvLine(line) {
  const out=[]; let cur=''; let quoted=false;
  for(let i=0;i<line.length;i++){ const ch=line[i]; if(ch==='"'){ if(quoted && line[i+1]==='"'){cur+='"';i++;} else quoted=!quoted; } else if(ch===','&&!quoted){out.push(cur);cur='';} else cur+=ch; }
  out.push(cur); return out;
}

async function profileCsv(filePath, name) {
  const input=fs.createReadStream(filePath);
  const rl=readline.createInterface({input,crlfDelay:Infinity});
  let header=null, rows=0, sample=[];
  for await (const line of rl) {
    if (!line.trim() && !header) continue;
    const vals=splitCsvLine(line);
    if (!header) { header=vals.map((v,i)=>String(v||`Column ${i+1}`).trim()||`Column ${i+1}`); continue; }
    rows++;
    if(sample.length<3){ const obj={}; header.forEach((h,i)=>obj[h]=vals[i]??null); sample.push(obj); }
  }
  const columns=(header||[]).map((name,i)=>({name,type:detectType(sample.map(r=>r[name]))}));
  return {sheets:[{name:'CSV',rows,dimensions:{rows:rows+1,columns:(header||[]).length},header_row:header?1:null,columns,sample}],total_rows:rows};
}

async function profileFile(filePath, name) {
  const ext=path.extname(name).toLowerCase();
  validateSpreadsheetMime(filePath,name);
  if(ext==='.csv') return profileCsv(filePath,name);
  return profileXlsx(filePath);
}

function rowValue(row, header, index) {
  const v = row.values.slice(1);
  return normalizeCell(v[index]);
}

async function readRows(filePath, name, sheetName, callback) {
  const ext=path.extname(name).toLowerCase();
  validateSpreadsheetMime(filePath,name);
  if(ext==='.csv'){
    if(sheetName && sheetName!=='CSV') throw new Error(`Sheet "${sheetName}" was not found in "${name}".`);
    const rl=readline.createInterface({input:fs.createReadStream(filePath),crlfDelay:Infinity});
    let header=null;
    for await(const line of rl){ if(!header){header=splitCsvLine(line).map((v,i)=>String(v||`Column ${i+1}`).trim()||`Column ${i+1}`);continue;} if(!line.trim())continue; const vals=splitCsvLine(line); const obj={}; header.forEach((h,i)=>obj[h]=vals[i]??null); await callback(obj,header); }
    return;
  }
  const reader=new ExcelJS.stream.xlsx.WorkbookReader(filePath,{entries:'emit',sharedStrings:'cache',hyperlinks:'ignore',worksheets:'emit'});
  let found=false;
  for await(const ws of reader){
    if(ws.name!==sheetName) continue;
    found=true; let header=null;
    for await(const row of ws){
      const vals=row.values.slice(1).map(normalizeCell);
      if(!header){ if(vals.some(v=>v!==null&&String(v).trim()!=='')) header=vals.map((v,i)=>String(v??`Column ${i+1}`).trim()||`Column ${i+1}`); continue; }
      const obj={}; header.forEach((h,i)=>obj[h]=vals[i]??null); await callback(obj,header);
    }
  }
  if(!found) throw new Error(`Sheet "${sheetName}" was not found in "${name}".`);
}

function coerceNumber(value) {
  if(typeof value==='number'&&Number.isFinite(value)) return value;
  if(typeof value==='string'){const cleaned=value.replace(/[$,%\s,]/g,''); if(cleaned!==''&&Number.isFinite(Number(cleaned))) return Number(cleaned);}
  return null;
}

function matchesFilters(row, filters=[]) {
  return filters.every(f=>{
    const actual=row[f.column];
    if(f.op==='eq') return String(actual??'')===String(f.value??'');
    if(f.op==='contains') return String(actual??'').toLowerCase().includes(String(f.value??'').toLowerCase());
    if(f.op==='gt'||f.op==='gte'||f.op==='lt'||f.op==='lte'){const a=coerceNumber(actual),b=coerceNumber(f.value); if(a===null||b===null)return false; return f.op==='gt'?a>b:f.op==='gte'?a>=b:f.op==='lt'?a<b:a<=b;}
    return false;
  });
}

async function queryExcelFile(filePath,name,args) {
  const {sheet,operation,column,filters=[],group_by,limit=10}=args;
  if(!sheet) throw new Error('A sheet is required.');
  const groups=new Map(); let count=0,sum=0,min=null,max=null;
  const values=[];
  await readRows(filePath,name,sheet,async row=>{
    if(!matchesFilters(row,filters)) return;
    count++;
    if(operation==='filter'){ if(values.length<Math.min(limit,50)) values.push(row); return; }
    if(operation==='group_by'){
      const key=String(row[group_by]??''); const g=groups.get(key)||{group:key,count:0,sum:0}; g.count++; const n=coerceNumber(row[column]); if(n!==null)g.sum+=n; groups.set(key,g); return;
    }
    const n=coerceNumber(row[column]); if(n===null)return;
    sum+=n; min=min===null?n:Math.min(min,n); max=max===null?n:Math.max(max,n); values.push(n);
  });
  if(operation==='sum') return {operation,count, value:sum};
  if(operation==='avg') return {operation,count, value:values.length?sum/values.length:null};
  if(operation==='min') return {operation,count, value:min};
  if(operation==='max') return {operation,count, value:max};
  if(operation==='filter') return {operation,count,rows:values};
  if(operation==='group_by'){
    const result=[...groups.values()].sort((a,b)=>b.sum-a.sum).slice(0,Math.min(limit,100));
    return {operation,count,group_by,result};
  }
  if(operation==='top_n'){
    const result=[]; await readRows(filePath,name,sheet,async row=>{if(matchesFilters(row,filters)){const n=coerceNumber(row[column]);if(n!==null)result.push({row,value:n});}}); result.sort((a,b)=>b.value-a.value); return {operation,count,rows:result.slice(0,Math.min(limit,50))};
  }
  throw new Error(`Unsupported Excel operation: ${operation}`);
}

async function buildWorkbook(outputPath,spec) {
  const workbook=new ExcelJS.Workbook();
  workbook.creator='David Personal Agent';
  for(const sheetSpec of (spec.sheets||[])){
    const ws=workbook.addWorksheet(String(sheetSpec.name||'Sheet').slice(0,31));
    const headers=Array.isArray(sheetSpec.headers)?sheetSpec.headers:[];
    if(headers.length) {
      ws.columns=headers.map(h=>({header:h,key:String(h),width:Math.min(42,Math.max(12,String(h).length+2))}));
      ws.getRow(1).font={bold:true};
      ws.views=[{state:'frozen',ySplit:1}];
    }
    for(const row of (sheetSpec.rows||[])) ws.addRow(Array.isArray(row)?row:headers.map(h=>row?.[h]??null));
  }
  await workbook.xlsx.writeFile(outputPath);
}
async function initExcelDb(pool) {
  if(!pool)return;
  ensureUploadDir();
  await pool.query(`CREATE TABLE IF NOT EXISTS excel_files (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    sheet_names TEXT[] NOT NULL DEFAULT '{}',
    total_rows INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'source',
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream'
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS excel_files_expires_idx ON excel_files(expires_at)');
  await purgeExpiredExcelFiles(pool);
}

async function purgeExpiredExcelFiles(pool) {
  if(!pool)return;
  const {rows}=await pool.query('SELECT id,path FROM excel_files WHERE expires_at<=NOW()');
  for(const row of rows){try{await fsp.unlink(row.path)}catch{}}
  await pool.query('DELETE FROM excel_files WHERE expires_at<=NOW()');
  const cutoff=Date.now()-FILE_TTL_MS;
  for(const name of await fsp.readdir(UPLOAD_DIR).catch(()=>[])){
    const file=path.join(UPLOAD_DIR,name); const stat=await fsp.stat(file).catch(()=>null);
    if(stat&&stat.mtimeMs<cutoff) await fsp.unlink(file).catch(()=>{});
  }
}

async function purgeMissingExcelFiles(pool){
  if(!pool)return;
  const {rows}=await pool.query('SELECT id,path FROM excel_files');
  for(const row of rows){if(!fs.existsSync(row.path)) await pool.query('DELETE FROM excel_files WHERE id=$1',[row.id]);}
}

async function getExcelFile(pool,id,kind='source'){
  if(!pool)return null;
  const {rows}=await pool.query('SELECT id,name,size_bytes,sheet_names,total_rows,created_at,expires_at,path,kind,mime_type FROM excel_files WHERE id=$1 AND kind=$2',[Number(id),kind]);
  return rows[0]||null;
}

async function createExcelFile(pool,{name,sizeBytes,path:filePath,profile,mimeType,kind='source'}){
  const expires=new Date(Date.now()+FILE_TTL_MS);
  const {rows}=await pool.query(`INSERT INTO excel_files(name,size_bytes,sheet_names,total_rows,expires_at,path,kind,mime_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,size_bytes,sheet_names,total_rows,created_at,expires_at`,[name,sizeBytes,profile?.sheets?.map(s=>s.name)||[],profile?.total_rows||0,expires,filePath,kind,mimeType]);
  return rows[0];
}

async function deleteExcelFile(pool,id){
  const file=await getExcelFile(pool,id,'source'); if(!file)return {ok:false,error:'Uploaded file not found.'};
  await fsp.unlink(file.path).catch(()=>{});
  await pool.query('DELETE FROM excel_files WHERE id=$1',[file.id]);
  return {ok:true,id:file.id,name:file.name};
}

module.exports={UPLOAD_DIR,MAX_FILE_BYTES,MAX_FILES_PER_MESSAGE,MAX_TOTAL_BYTES,FILE_TTL_MS,ensureUploadDir,isSpreadsheetName,isImageName,sniffMime,validateSpreadsheetMime,profileFile,readRows,queryExcelFile,buildWorkbook,initExcelDb,purgeExpiredExcelFiles,purgeMissingExcelFiles,getExcelFile,createExcelFile,deleteExcelFile,safeFileName};
