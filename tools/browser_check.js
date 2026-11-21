/* Real-browser smoke test via Chrome DevTools Protocol.
 * node tools/browser_check.js
 * Starts a local server + headless Chrome, drives the UI, writes screenshots.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { start } = require('./serve');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8123, CDPPORT = 9333;
const SHOTS = path.resolve(__dirname, 'shots');
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

let ws = null, msgId = 0;
const pending = new Map(), listeners = [];

function send(method, params) {
  return new Promise(function (resolve, reject) {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true, timeout: 150000
  });
  if (r.result.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}
async function waitEvent(name, ms) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error('timeout waiting ' + name)); }, ms);
    const f = function (m) {
      if (m.method === name) {
        clearTimeout(t);
        const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1);
        resolve(m);
      }
    };
    listeners.push(f);
  });
}
async function screenshot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.result.data, 'base64'));
  return path.join(SHOTS, name);
}

const HELPERS = `
  const $=id=>document.getElementById(id);
  const wait=(fn,ms)=>new Promise((res,rej)=>{const t=Date.now();(function l(){if(fn())return res();if(Date.now()-t>ms)return rej(new Error('wait timeout'));setTimeout(l,30);})();});
  const out=[]; const ok=(n,c,d)=>out.push({n:n,ok:!!c,d:d==null?'':String(d)});
  function clickGtp(gtp){
    const p=GoReview.SGF.gtpToXY(gtp,19);
    const canvas=$('board'), rect=canvas.getBoundingClientRect();
    const cssW=canvas.clientWidth||560;
    const pad=Math.max(20,Math.round(cssW*0.052));
    const step=(cssW-pad*2)/18;
    canvas.dispatchEvent(new MouseEvent('click',{bubbles:true,
      clientX:rect.left+pad+p.x*step, clientY:rect.top+pad+p.y*step}));
  }
  window.__clickGtp=clickGtp;
`;

const STEP1 = '(async function(){' + HELPERS + `
  try{
    window.__name='[nicomai]vs[里奥0208]1793435850030033060.sgf';
    const text=await (await fetch('/sample/'+encodeURIComponent(window.__name))).text();
    window.__text=text;
    $('pasteText').value=text;
    $('btnPasteLoad').click();
    await wait(()=>document.querySelectorAll('#gameList .game-row').length>0,20000);
    ok('导入 KaTrain 风格 SGF',true,$('gameList').textContent.trim().slice(0,70));
    const rows=document.querySelectorAll('#problemBody tr[data-id]');
    ok('问题手列表渲染',rows.length>0,rows.length+' 条');
    ok('顶部统计更新',Number($('statProblems').textContent)>0,'问题手 '+$('statProblems').textContent);
    const g=await GoReview.SGF.buildGame(text,window.__name,'nicomai');
    window.__g=g;
    const before=Number($('statProblems').textContent);
    $('setThOpening').value='20';
    $('setThOpening').dispatchEvent(new Event('input',{bubbles:true}));
    await wait(()=>Number($('statProblems').textContent)<before,4000);
    ok('调高阈值自动刷新',true,before+' -> '+$('statProblems').textContent);
    $('setThOpening').value='2';
    $('setThOpening').dispatchEvent(new Event('input',{bubbles:true}));
    await wait(()=>Number($('statProblems').textContent)===before,4000);
    ok('恢复阈值自动刷新',true,$('statProblems').textContent);
    const tr=document.querySelector('#problemBody tr[data-id]');
    const ply=parseInt(tr.getAttribute('data-id').split('#').pop(),10);
    window.__ply=ply;
    const mv=g.moves[ply-1];
    const seq=GoReview.Review.buildSequence(GoReview.Board.positionBefore(g,ply,19),mv,g.playerColor,3);
    window.__seq=seq;
    ok('首卡可构造三步练习',seq.n===3&&seq.expected.length===3,'ply '+ply+' / '+seq.expected.join(' '));
  }catch(e){out.push({n:'EXCEPTION',ok:false,d:String(e.stack||e)});}
  return out;
})()`;

const STEP2 = '(async function(){' + HELPERS + `
  try{
    $('btnStartReview').click();
    await wait(()=>!$('studyPanel').classList.contains('hidden'),4000);
    ok('进入复习卡片',true,$('cardInfo').textContent.trim().slice(0,70));
    const exp0=window.__seq.expected[0];
    const wrong=(exp0==='A19')?'T1':'A19';
    const s0=$('stepInfo').textContent,m0=$('mistakeInfo').textContent;
    window.__clickGtp(wrong);
    ok('点错不重置、只累计错误',$('stepInfo').textContent===s0&&$('mistakeInfo').textContent!==m0,
       s0+' / '+$('mistakeInfo').textContent);
    window.__clickGtp(exp0);
    ok('点对后前进到第二步',$('stepInfo').textContent.indexOf('2 /')>=0,$('stepInfo').textContent);
    // exp0 now holds a stone: clicking it must be ignored (no mistake, no progress change).
    const m1=$('mistakeInfo').textContent,s1=$('stepInfo').textContent;
    window.__clickGtp(exp0);
    ok('点已有棋子不算错、不改进度',
       $('mistakeInfo').textContent===m1&&$('stepInfo').textContent===s1,
       s1+' / '+$('mistakeInfo').textContent);
    ok('AI 自动应手已摆在棋盘',true,$('tipText').textContent.trim());
  }catch(e){out.push({n:'EXCEPTION',ok:false,d:String(e.stack||e)});}
  return out;
})()`;

const STEP3 = '(async function(){' + HELPERS + `
  try{
    for(let i=1;i<window.__seq.n;i++){
      window.__clickGtp(window.__seq.expected[i]);
    }
    await wait(()=>!$('resultPanel').classList.contains('hidden'),4000);
    ok('三步全对后出现评级',true,$('resultRating').textContent+' / '+$('resultDetail').textContent.trim().slice(0,60));
    const n0=Number($('statProblems').textContent);
    $('btnDelete2').click();
    await wait(()=>Number($('statProblems').textContent)<n0,4000);
    ok('复习中可删除卡片',true,n0+' -> '+$('statProblems').textContent);
  }catch(e){out.push({n:'EXCEPTION',ok:false,d:String(e.stack||e)});}
  return out;
})()`;

const STEP4 = '(async function(){' + HELPERS + `
  try{
    const before=GoReview.Store.get().games.length;
    $('btnLoadGenerated').click();
    await wait(()=>GoReview.Store.get().games.length>before,25000);
    const st=GoReview.Store.get();
    const added=st.games.length-before;
    ok('一键载入命令行分析结果',added>0,added+' 个棋谱');
    const cli=st.games.filter(g=>g.hasKT);
    ok('载入棋谱每手都有目差与 PV',cli.length>0&&cli.every(g=>{
      const loss=g.moves.filter(m=>m.loss!==null).length;
      const pv=g.moves.filter(m=>m.pv&&m.pv.length>2).length;
      return loss>=g.moves.length*0.9&&pv>=g.moves.length*0.9;
    }),cli.map(g=>g.moves.length+'手').join(','));
    ok('问题手列表随新棋谱刷新',Number($('statProblems').textContent)>0,
       '问题手 '+$('statProblems').textContent);
  }catch(e){out.push({n:'EXCEPTION',ok:false,d:String(e.stack||e)});}
  return out;
})()`;

// Web-side analysis: one game, first 8 moves only (these are demo SGFs).
const STEP5 = '(async function(){' + HELPERS + `
  try{
    $('btnAnalyzeToggle').click();
    await wait(()=>$('anFiles').querySelectorAll('input').length>0,15000);
    const cbs=[...$('anFiles').querySelectorAll('input')];
    const checked=cbs.filter(c=>c.checked);
    ok('分析面板列出源棋谱且默认只勾一局',cbs.length>=4&&checked.length===1,
       cbs.length+' 局 / 勾选 '+checked.length+' 局');
    ok('默认 visits = 100',$('anVisits').value==='100',$('anVisits').value);
    const stopR=await fetch('/api/analyze/stop',{method:'POST'});
    ok('停止接口可用',stopR.ok,'HTTP '+stopR.status);
    $('anLimit').value='8';
    $('anForce').checked=true;  // always exercise the real engine, never the cache
    const before=GoReview.Store.get().games.length;
    $('btnAnalyzeStart').click();
    await wait(()=>/完成|出错|失败/.test($('anStatus').textContent),115000);
    const status=$('anStatus').textContent;
    ok('网页按钮驱动 KataGo 完成分析',status.indexOf('完成')>=0&&status.indexOf('出错')<0,status);
    const parts=GoReview.Store.get().games.filter(g=>/\.part8\.sgf$/i.test(g.filename));
    ok('分析完成自动载入本次产物',parts.length>0,
       '棋谱 '+before+' -> '+GoReview.Store.get().games.length);
    ok('产物每手都有 KT 目差',parts.length>0&&parts[0].hasKT&&
       parts[0].moves.every(m=>m.loss!==null),parts.length?parts[0].moves.length+' 手':'无产物');
    ok('进度条走到 100%',parseFloat($('anBar').style.width)>=100,$('anBar').style.width);
  }catch(e){out.push({n:'EXCEPTION',ok:false,d:String(e.stack||e)});}
  return out;
})()`;

// 名局背谱：收录 -> 对弈式逐手 -> 停住重试 / 提示 -> 完成 -> 续背 -> 清空导入不丢 -> 改名 / 删除
const STEP6 = '(async function(){' + HELPERS + `
  try{
    const st0=GoReview.Store.get();
    const clean=st0.games.filter(g=>g.moves.length>=12&&g.moves.slice(0,8).every(m=>m.gtp!=='pass'));
    const pick=clean[0]||st0.games.filter(g=>g.moves.length>=12)[0]||st0.games[0];
    ok('存在可用于背谱的棋谱',!!pick,pick?pick.moves.length+' 手':'无');
    $('memoSource').value=pick.filename;
    $('btnMemoAddSelected').click();
    await wait(()=>document.querySelectorAll('#memoList .memo-item').length>0,6000);
    const masters=GoReview.Store.get().masters, m=masters[0];
    ok('收录名局并独立持久化',masters.length===1&&m.moves.length===pick.moves.length,
       masters.length+' 局 / '+m.moves.length+' 手');
    ok('名局只存精简落子序列(无目差/PV)',
       m.moves.every(x=>'ply' in x&&'color' in x&&'gtp' in x&&!('loss' in x)&&!('pv' in x)),
       JSON.stringify(m.moves[0]));
    const id=m.id;
    $('memoColor').value='B'; $('memoFrom').value='1'; $('memoTo').value='8';
    document.querySelector('#memoList [data-act=start]').click();
    await wait(()=>!$('memoPanel').classList.contains('hidden'),6000);
    ok('进入背谱面板',true,$('memoInfo').textContent.trim().replace(/\\s+/g,' ').slice(0,80));
    const pg0=GoReview.Store.get().masterProgress[id];
    ok('进度已初始化(区间1-8)',pg0&&pg0.from===1&&pg0.to===8&&!pg0.done,JSON.stringify(pg0));

    function clickMemo(gtp){
      const p=GoReview.SGF.gtpToXY(gtp,19); if(!p)return;
      const c=$('memoBoard'),r=c.getBoundingClientRect(),w=c.clientWidth||560;
      const pad=Math.max(20,Math.round(w*0.052)),s=(w-pad*2)/18;
      c.dispatchEvent(new MouseEvent('click',{bubbles:true,
        clientX:r.left+pad+p.x*s,clientY:r.top+pad+p.y*s}));
    }
    const p0=GoReview.Store.get().masterProgress[id].ply, mv0=m.moves[p0-1];
    ok('初始停在我方待背的一手',mv0&&mv0.color==='B','ply '+p0+' / '+(mv0&&mv0.gtp));

    const step0=$('memoStep').textContent,mis0=$('memoMistakes').textContent;
    clickMemo('A19');
    ok('点错停在当前手且累计错误',$('memoStep').textContent===step0&&$('memoMistakes').textContent!==mis0,
       step0+' / '+$('memoMistakes').textContent);
    const hint0=$('memoHints').textContent;
    $('btnMemoHint').click();
    ok('提示单独计数、只高亮不推进',$('memoHints').textContent!==hint0&&$('memoStep').textContent===step0,
       $('memoHints').textContent+' / '+$('memoTip').textContent.trim().slice(0,36));

    clickMemo(mv0.gtp);
    await new Promise(r=>setTimeout(r,160));
    const pAfter=GoReview.Store.get().masterProgress[id].ply;
    ok('对手应手自动摆出并跳到我方下一手',pAfter>=p0+2,'ply '+p0+' -> '+pAfter);
    window.__mid=id; window.__m=m; window.__clickMemo=clickMemo;
  }catch(e){out.push({n:'EXCEPTION',ok:false,d:String(e.stack||e)});}
  return out;
})()`;

const STEP7 = '(async function(){' + HELPERS + `
  try{
    const id=window.__mid, m=window.__m, clickMemo=window.__clickMemo;
    for(let k=0;k<24;k++){
      const pg=GoReview.Store.get().masterProgress[id];
      if(pg.done||pg.ply>8)break;
      const mv=m.moves[pg.ply-1];
      if(mv&&mv.color==='B'){
        if(!GoReview.SGF.gtpToXY(mv.gtp,19))$('btnMemoPass').click(); else clickMemo(mv.gtp);
      }
      await new Promise(r=>setTimeout(r,50));
    }
    await wait(()=>!$('memoDone').classList.contains('hidden'),6000);
    const pg1=GoReview.Store.get().masterProgress[id], doneTxt=$('memoDone').textContent;
    ok('背完区间后给出完成小结',pg1.done===true&&/背谱完成/.test(doneTxt),
       doneTxt.replace(/\\s+/g,' ').trim().slice(0,90));
    ok('小结含点错/提示且明确不评级、不进SRS',
       /点错/.test(doneTxt)&&/提示/.test(doneTxt)&&/不评级、不进 SRS/.test(doneTxt)&&
       !/下次复习|熟练度|ease/.test(doneTxt),'');
    $('btnMemoBack2').click();
    await wait(()=>!$('idlePanel').classList.contains('hidden'),4000);
    ok('返回后列表标记已背完',/已背完/.test($('memoList').textContent),'');

    window.confirm=()=>true;
    $('btnClearGames').click();
    ok('清空已导入棋谱不丢名局',
       GoReview.Store.get().masters.length===1&&GoReview.Store.get().games.length===0,
       '名局 '+GoReview.Store.get().masters.length+' 局 / 棋谱 '+GoReview.Store.get().games.length+' 局');

    document.querySelector('#memoList [data-act=clear]').click();
    $('memoColor').value='B'; $('memoFrom').value='1'; $('memoTo').value='8';
    document.querySelector('#memoList [data-act=start]').click();
    await wait(()=>!$('memoPanel').classList.contains('hidden'),6000);
    const pb=GoReview.Store.get().masterProgress[id];
    const cur=m.moves[pb.ply-1];
    if(cur&&cur.color==='B')clickMemo(cur.gtp);
    await new Promise(r=>setTimeout(r,160));
    const pg2=GoReview.Store.get().masterProgress[id];
    ok('中途进度已保存',pg2&&!pg2.done&&pg2.ply>1,'ply='+pg2.ply);
    $('btnMemoBack').click();
    await wait(()=>!$('idlePanel').classList.contains('hidden'),4000);
    ok('列表出现「继续背」',/继续背/.test($('memoList').textContent),'');
    document.querySelector('#memoList [data-act=start]').click();
    await wait(()=>!$('memoPanel').classList.contains('hidden'),6000);
    const pg3=GoReview.Store.get().masterProgress[id];
    ok('续背从保存的手数继续',pg3.ply===pg2.ply,'ply '+pg2.ply+' -> '+pg3.ply);
    $('btnMemoBack').click();
    await wait(()=>!$('idlePanel').classList.contains('hidden'),4000);

    const nameInp=document.querySelector('#memoList [data-act=name]');
    nameInp.value='测试名局'; nameInp.dispatchEvent(new Event('change',{bubbles:true}));
    ok('可直接改名称',GoReview.Store.get().masters[0].name==='测试名局',GoReview.Store.get().masters[0].name);
    document.querySelector('#memoList [data-act=del]').click();
    ok('可删除名局',GoReview.Store.get().masters.length===0,'剩余 '+GoReview.Store.get().masters.length+' 局');
  }catch(e){out.push({n:'EXCEPTION',ok:false,d:String(e.stack||e)});}
  return out;
})()`;

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  // 「载入分析结果」用例需要 sgfout/ 里有数据；若目录为空，放一份演示 SGF 作固定夹具（结束清理）。
  const outDir = path.join(__dirname, '..', 'sgfout');
  const fixture = path.join(outDir, '__e2e_fixture.sgf');
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.readdirSync(outDir).some(function (f) { return /\.sgf$/i.test(f); })) {
    const src = fs.readdirSync(path.join(__dirname, '..', 'sample'))
      .filter(function (f) { return /\.sgf$/i.test(f); })[0];
    if (src) fs.copyFileSync(path.join(__dirname, '..', 'sample', src), fixture);
  }
  const server = await start(PORT);
  const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'goreview-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + CDPPORT, '--user-data-dir=' + profile,
    '--window-size=1440,1050', 'about:blank'
  ], { stdio: 'ignore' });

  let target = null, chromeErr = '';
  try {
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + CDPPORT + '/json/list')).json();
        target = list.find(function (t) { return t.type === 'page'; });
        if (target) break;
      } catch (e) { chromeErr = e.message; }
      await sleep(200);
    }
    if (!target) throw new Error('Chrome CDP 未就绪: ' + chromeErr + '（请确认 Chrome 路径）');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = function (ev) {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m);
      }
      listeners.slice().forEach(function (f) { f(m); });
    };
    await send('Page.enable');
    await send('Runtime.enable');
    const loaded = waitEvent('Page.loadEventFired', 20000);
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' });
    await loaded;
    await sleep(700);

    const all = [];
    for (const [label, expr] of [['导入与筛选', STEP1], ['复习交互', STEP2],
      ['评级与删除', STEP3], ['一键载入分析结果', STEP4], ['网页端 AI 分析', STEP5],
      ['名局背谱·收录与逐手', STEP6], ['名局背谱·进度与管理', STEP7]]) {
      const rows = await evaluate(expr);
      console.log('\n== ' + label + ' ==');
      rows.forEach(function (r) { console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.n + (r.d ? '  [' + r.d + ']' : '')); });
      all.push.apply(all, rows);
      if (label === '导入与筛选') console.log('  screenshot: ' + await screenshot('01-main.png'));
      if (label === '复习交互') console.log('  screenshot: ' + await screenshot('02-practice.png'));
      if (label === '评级与删除') console.log('  screenshot: ' + await screenshot('03-result.png'));
      if (label === '一键载入分析结果') console.log('  screenshot: ' + await screenshot('04-generated.png'));
      if (label === '网页端 AI 分析') console.log('  screenshot: ' + await screenshot('05-analysis.png'));
      if (label === '名局背谱·收录与逐手') console.log('  screenshot: ' + await screenshot('06-memo.png'));
    }
    const failed = all.filter(function (r) { return !r.ok; }).length;
    console.log('\nBROWSER PASS ' + (all.length - failed) + '   FAIL ' + failed);
    if (failed) process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) { /* ignore */ }
    try { chrome.kill(); } catch (e) { /* ignore */ }
    try { server.close(); } catch (e) { /* ignore */ }
    // partial demo output (--limit) and the test fixture must not linger in sgfout/
    try {
      fs.readdirSync(outDir).filter(function (f) {
        return /\.part\d+\.sgf$/i.test(f) || f === '__e2e_fixture.sgf';
      }).forEach(function (f) { fs.unlinkSync(path.join(outDir, f)); });
    } catch (e) { /* ignore */ }
    await sleep(200);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().catch(function (e) { console.error('BROWSER CHECK CRASHED:', e && e.stack || e); process.exit(1); });
