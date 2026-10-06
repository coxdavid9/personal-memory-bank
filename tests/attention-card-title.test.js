const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../public/index.html'),'utf8');
const context={esc:value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),attentionStates:new Map(),attentionIsVisible:()=>true};
vm.createContext(context);vm.runInContext(html.slice(html.indexOf('function attentionCardTitle('),html.indexOf('function renderAttention(')),context);
test('long project cards show a compact action with project name and full source detail',()=>{
 const text='No open GitHub issue or PR currently records the remaining launch work. Before selecting a feature from old notes, refresh this file from the current launch checklist and production behavior. The next useful project action is therefore: audit launch readiness against the live product and record each remaining blocker here as a concrete unchecked item or GitHub issue.';
 const item={id:'abc',domain:'project',repository:'coxdavid9/clearcfo',text,why:'Recorded plan'};
 const title=context.attentionCardTitle(item);assert.ok(title.startsWith('audit launch readiness'));assert.ok(title.length<=120);
 const card=context.attentionCardHtml(item);assert.ok(card.includes('project · clearcfo'));assert.ok(card.includes('<h3>'+title+'</h3>'));assert.ok(card.includes('<p>'+text+'</p>'));
 const cma={...item,repository:'coxdavid9/CMA-Agent',text:'Build reviewed questions for the highest-priority thin/missing skills, starting with Corporate Finance and Professional Ethics, without duplicating active tasks. Update the audit/coverage artifacts as coverage improves.'};
 assert.equal(context.attentionCardTitle(cma),'Build reviewed questions for the highest-priority thin/missing skills');assert.ok(context.attentionCardHtml(cma).includes('CMA-Agent'));
});
test('short and nonproject cards keep their text and all card details remain escaped',()=>{
 assert.equal(context.attentionCardTitle({domain:'project',text:'Audit launch readiness.'}),'Audit launch readiness.');
 const item={id:'abc',domain:'email',text:'Review <script>alert(1)</script>',why:'<script>bad</script>'};
 assert.equal(context.attentionCardTitle(item),item.text);assert.ok(!context.attentionCardHtml(item).includes('<script>'));
});
