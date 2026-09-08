(function(){
'use strict';

var S={fileName:'',fileSize:0,fileType:'',rawText:'',chapters:[],currentChapter:0,epubCSS:'',epubTitle:'',toc:null,theme:'light',fontSize:18,lineHeight:1.85,padding:'normal',textColor:'',searchQuery:'',searchResults:[],searchIdx:-1,hiddenShelf:false,librarySort:'recent',storeMode:'inline',convSimp:false,stickyHead:true,pomoMin:25,libraryCat:'__all__',davSyncMode:'auto',transEnabled:false,transEngine:'auto'};
var _searchToken=0,_tocItems=[],_tocScrollBound=false,_tocItemH=40;
var $=function(id){return document.getElementById(id)};
var bookshelf=$('bookshelf'),loading=$('loading'),loadingText=$('loading-text');
var reader=$('reader'),toolbar=$('toolbar');
var contentEl=$('content'),contentInner=$('content-inner');
var sidebar=$('sidebar'),sidebarOverlay=$('sidebar-overlay');
var tocList=$('toc-list'),bmList=$('bm-list');
var settingsEl=$('settings'),settingsOverlay=$('settings-overlay');
var tbTitle=$('tb-title'),searchBar=$('search-bar'),searchInput=$('search-input'),searchCount=$('search-count');
var progressFill=$('progress-fill'),progressThumb=$('progress-thumb'),progressTip=$('progress-tip'),progressTrack=$('progress-track');
var toastEl=$('toast'),fileInput=$('file-input');
var confirmOverlay=$('confirm-overlay'),confirmMsg=$('confirm-msg'),confirmOkBtn=$('confirm-ok'),confirmCancelBtn=$('confirm-cancel');
var bookshelfSearch=$('bs-search-input'),bookshelfSort=$('bs-sort'),bookshelfTools=$('bs-library-tools');
var firstLoaded=-1,lastLoaded=-1,isAdjusting=false,_progData=null,_rs=0,_rt=null,_rtSec=null,_touchTap=false;
var importDropdownMenu=$('import-dropdown-menu');
var coverHues=[25,42,120,175,210,260,330,15,55,150,200,280,350,80,300,10];
var _hlList=null,_repList=null;
function clearBookCache(){_hlList=null;_repList=null;_textCache=null;_textCacheLen=0}
var _pomo=null,_pomoTimer=null;
var _antPopIdx=-1,_catTarget=null,_selCache=null;
var POMO_COLORS=['#e05a4e','#d98a1f','#2f9e44','#1d7fd4','#8a5ac1','#c2577a'];
var POMO_ICON='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/></svg>';
var _selToolbar=null,_stColors=null,_antPop=null,_catPop=null,_catPopList=null,_transCache=null,_lastTransText='',_lastTransResult=null,_transSessionActive=false;
var CH_HEADING_GAP=10,BM_OFFSET_TOL=200,SCROLL_BOUND=800,PARA_MAX=4000,SAVE_DELAY=800,PROC_DELAY=30,TOAST_MS=1800,SEARCH_DELAY=200,SNIP_MAX=100,TRIM_WIN=4;
/* ===== 外部模块桥接（webdav.js / epub.js 提供实现，延迟到运行时解析） ===== */
var parseEPUB=function(buf,cb){var m=window.EPUB;return m?m.parseEPUB(buf,cb):cb(null,'EPUB 解析器未加载')};
var hrefMatch=function(a,b){var m=window.EPUB;return m?m.hrefMatch(a,b):false};
var findChapterByHref=function(href){var m=window.EPUB;return m?m.findChapterByHref(href):-1};

function on(el,ev,fn,opt){if(el)el.addEventListener(ev,fn,opt||false)}
loadSettings();loadHiddenShelf();applySettings();setupEvents();setupProgressDrag();renderBookshelf();

/* ===== IndexedDB（连接单例 + 章节分表 v2） =====
 * books: 元数据 + 轻量 chaptersMeta；大 HTML 不再整本塞进一条记录
 * chapters: keyPath [book, idx]，按需加载 html/text
 * 兼容 v1：books.chapters 仍含全文时走 legacy 内存模式
 */
var DBN='JingDuV2',DBV=3,STORE='books',CH_STORE='chapters',WEB_STORE='webdavSecrets';
var _db=null,_dbWaiters=[],_dbOpening=false;
function openDB(cb){
  if(_db){cb(_db);return}
  _dbWaiters.push(cb);
  if(_dbOpening)return;
  _dbOpening=true;
  if(!window.indexedDB){
    _dbOpening=false;
    var fail=_dbWaiters.splice(0);for(var fi=0;fi<fail.length;fi++)fail[fi](null);
    return;
  }
  var r=indexedDB.open(DBN,DBV);
  r.onupgradeneeded=function(e){
    var d=e.target.result;
    if(!d.objectStoreNames.contains(STORE))d.createObjectStore(STORE,{keyPath:'name'});
    if(!d.objectStoreNames.contains(CH_STORE)){
      var cs=d.createObjectStore(CH_STORE,{keyPath:['book','idx']});
      cs.createIndex('byBook','book',{unique:false});
    }
    if(!d.objectStoreNames.contains(WEB_STORE))d.createObjectStore(WEB_STORE,{keyPath:'id'});
  };
  r.onsuccess=function(e){
    _db=e.target.result;
    _db.onclose=function(){_db=null};
    _db.onversionchange=function(){try{if(_db)_db.close()}catch(err){}_db=null};
    _dbOpening=false;
    var ok=_dbWaiters.splice(0);for(var i=0;i<ok.length;i++)ok[i](_db);
  };
  r.onerror=function(){
    _dbOpening=false;
    var bad=_dbWaiters.splice(0);for(var j=0;j<bad.length;j++)bad[j](null);
  };
}
function _chTextLen(ch){
  if(!ch)return 1;
  if(ch.textLen)return Math.max(1,ch.textLen|0);
  if(ch.text)return Math.max(1,ch.text.length);
  if(ch.content)return Math.max(1,ch.content.length);
  if(ch.html)return Math.max(1,Math.min(ch.html.length,500000));
  return 1;
}
function dbSave(name,data,cb){
  openDB(function(db){
    if(!db){cb&&cb(false);return}
    var isEpub=data.type==='epub';
    var chapters=data.chapters||null;
    var useSplit=isEpub&&chapters&&chapters.length>0;
    var meta={
      name:name,
      text:data.text||'',
      type:data.type,
      size:data.size,
      cover:data.cover||null,
      epubCSS:data.epubCSS||'',
      toc:data.toc||null,
      epubTitle:data.epubTitle||'',
      source:data.source||null,
      chapters:null,
      chaptersMeta:null,
      v:useSplit?2:1
    };
    if(useSplit){
      meta.chaptersMeta=chapters.map(function(ch){
        return{title:ch.title||'',href:ch.href||'',textLen:_chTextLen(ch),hasHtml:!!(ch.html&&ch.html.length)};
      });
    }else if(isEpub&&chapters){
      meta.chapters=chapters.map(function(ch){return{title:ch.title||'',html:ch.html||'',href:ch.href||'',text:ch.text||ch.content||''}});
      meta.v=1;
    }
    var stores=useSplit?[STORE,CH_STORE]:[STORE];
    if(useSplit&&!db.objectStoreNames.contains(CH_STORE)){
      /* 极旧环境无 chapters 表时退回整本写入 */
      useSplit=false;stores=[STORE];meta.v=1;meta.chaptersMeta=null;
      meta.chapters=chapters.map(function(ch){return{title:ch.title||'',html:ch.html||'',href:ch.href||'',text:ch.text||''}});
    }
    var tx=db.transaction(stores,'readwrite');
    tx.objectStore(STORE).put(meta);
    if(useSplit){
      var chOs=tx.objectStore(CH_STORE);
      var delReq=chOs.index('byBook').openCursor(IDBKeyRange.only(name));
      delReq.onsuccess=function(ev){
        var cursor=ev.target.result;
        if(cursor){cursor.delete();cursor.continue();return}
        /* 须在同一事务回调内同步 put，不可 setTimeout 否则事务会提前提交 */
        for(var i=0;i<chapters.length;i++){
          var ch=chapters[i];
          chOs.put({
            book:name,idx:i,
            title:ch.title||'',href:ch.href||'',
            html:ch.html||'',text:ch.text||ch.content||''
          });
        }
      };
    }
    tx.oncomplete=function(){cb&&cb(true)};
    tx.onerror=function(){cb&&cb(false)};
  });
}
function dbLoad(name,cb){
  openDB(function(db){
    if(!db){cb(null);return}
    var tx=db.transaction(STORE,'readonly');
    var r=tx.objectStore(STORE).get(name);
    r.onsuccess=function(){cb(r.result||null)};
    r.onerror=function(){cb(null)};
  });
}
function dbLoadChapters(name,indices,cb){
  if(!indices||!indices.length){cb([]);return}
  openDB(function(db){
    if(!db||!db.objectStoreNames.contains(CH_STORE)){cb(indices.map(function(){return null}));return}
    var tx=db.transaction(CH_STORE,'readonly');
    var os=tx.objectStore(CH_STORE);
    var out=new Array(indices.length);
    var left=indices.length;
    indices.forEach(function(idx,pos){
      var req=os.get([name,idx]);
      req.onsuccess=function(){out[pos]=req.result||null;if(--left<=0)cb(out)};
      req.onerror=function(){out[pos]=null;if(--left<=0)cb(out)};
    });
  });
}
/* 在 chapters 表上扫 text 做全文搜索（不把全书灌进内存） */
function dbScanSearch(name,q,token,onDone){
  openDB(function(db){
    if(!db||!db.objectStoreNames.contains(CH_STORE)){onDone([]);return}
    var ql=q.toLowerCase();
    var results=[];
    var tx=db.transaction(CH_STORE,'readonly');
    var req=tx.objectStore(CH_STORE).index('byBook').openCursor(IDBKeyRange.only(name));
    var batch=0;
    req.onsuccess=function(e){
      if(token!=null&&token!==_searchToken){try{tx.abort()}catch(err){}onDone(null);return}
      var cursor=e.target.result;
      if(!cursor)return;
      var row=cursor.value;
      var t=convText(row.text||'').toLowerCase();
      if(t){
        var p=0,step=ql.length||1;
        while((p=t.indexOf(ql,p))!==-1){results.push({ch:row.idx,pos:p});p+=step}
      }
      batch++;
      if(batch%40===0){setTimeout(function(){try{cursor.continue()}catch(err){}},0)}
      else cursor.continue();
    };
    tx.oncomplete=function(){onDone(token!=null&&token!==_searchToken?null:results)};
    tx.onerror=function(){onDone([])};
  });
}
function dbDelete(name,cb){
  openDB(function(db){
    if(!db){cb&&cb();return}
    var stores=[STORE];
    if(db.objectStoreNames.contains(CH_STORE))stores.push(CH_STORE);
    var tx=db.transaction(stores,'readwrite');
    tx.objectStore(STORE).delete(name);
    if(stores.length>1){
      var del=tx.objectStore(CH_STORE).index('byBook').openCursor(IDBKeyRange.only(name));
      del.onsuccess=function(e){var c=e.target.result;if(c){c.delete();c.continue()}};
    }
    tx.oncomplete=function(){cb&&cb()};
    tx.onerror=function(){cb&&cb()};
  });
}
function dbClearAll(cb){
  openDB(function(db){
    if(!db){cb&&cb(false);return}
    var stores=[STORE];
    if(db.objectStoreNames.contains(CH_STORE))stores.push(CH_STORE);
    var tx=db.transaction(stores,'readwrite');
    for(var i=0;i<stores.length;i++)tx.objectStore(stores[i]).clear();
    tx.oncomplete=function(){cb&&cb(true)};
    tx.onerror=function(){cb&&cb(false)};
  });
}

/* ===== 章节按需加载（内存） ===== */
/* storeMode: 'v2' 分表 | 'legacy' 整本在内存 | 'inline' txt/md 现场拆章 */
var CH_KEEP_PAD=3;
/* 导入后 IDB 未写完前禁止释放正文，避免滚动按需加载读到空数据 */
var _idbPersistReady=true;
function releaseChapterBodies(){
  if(!_idbPersistReady)return;
  if(S.storeMode!=='v2'||!S.chapters||!S.chapters.length)return;
  var cur=S.currentChapter|0;
  var lo=Math.max(0,cur-TRIM_WIN-CH_KEEP_PAD);
  var hi=Math.min(S.chapters.length-1,cur+TRIM_WIN+CH_KEEP_PAD);
  if(firstLoaded>=0)lo=Math.min(lo,firstLoaded);
  if(lastLoaded>=0)hi=Math.max(hi,lastLoaded);
  for(var i=0;i<S.chapters.length;i++){
    if(i>=lo&&i<=hi)continue;
    var ch=S.chapters[i];
    if(ch&&ch._loaded){ch.html=null;ch.text=null;ch._loaded=false}
  }
}
function ensureChapters(indices,cb){
  if(S.storeMode!=='v2'){cb&&cb();return}
  var need=[],seen={};
  for(var i=0;i<indices.length;i++){
    var idx=indices[i];
    if(idx<0||idx>=S.chapters.length||seen[idx])continue;
    seen[idx]=1;
    if(!S.chapters[idx]._loaded)need.push(idx);
  }
  if(!need.length){cb&&cb();return}
  dbLoadChapters(S.fileName,need,function(rows){
    for(var j=0;j<need.length;j++){
      var ch=S.chapters[need[j]],row=rows[j];
      if(row){
        ch.html=row.html||'';
        ch.text=row.text||'';
        ch.title=ch.title||row.title||'';
        ch.href=ch.href||row.href||'';
        ch.textLen=Math.max(1,(row.text||'').length||ch.textLen||1);
        ch._sanitized=true;
      }else{ch.html=ch.html||'';ch.text=ch.text||'';}
      ch._loaded=true;
    }
    releaseChapterBodies();
    cb&&cb();
  });
}
function rangeIndices(from,to){
  var a=[];from=Math.max(0,from);to=Math.min(S.chapters.length-1,to);
  for(var i=from;i<=to;i++)a.push(i);
  return a;
}

/* ===== Library ===== */
function getLib(){try{return JSON.parse(localStorage.getItem('jd_lib'))||[]}catch(e){return[]}}
function saveLib(l){try{localStorage.setItem('jd_lib',JSON.stringify(l))}catch(e){}}
function addToLib(n,s,tp,cv,src){var l=getLib().filter(function(b){return b.n!==n});l.unshift({n:n,s:s,tp:tp,ts:Date.now(),cv:cv||null,pv:S.hiddenShelf?true:false,src:src||''});saveLib(l)}
function removeFromLib(n){saveLib(getLib().filter(function(b){return b.n!==n}))}
function touchLib(n){var l=getLib();for(var i=0;i<l.length;i++){if(l[i].n===n){l[i].ts=Date.now();break}}saveLib(l)}

/* ===== Cover Generation (Canvas) ===== */
function generateCoverDataUrl(name){
  try{
    var W=160,H=224,dpr=Math.max(1,window.devicePixelRatio||1);
    var c=document.createElement('canvas');c.width=W*dpr;c.height=H*dpr;var ctx=c.getContext('2d');
    ctx.scale(dpr,dpr);
    var title=name.replace(/\.[^.]+$/,'');
    var h=0;for(var i=0;i<name.length;i++)h=name.charCodeAt(i)+((h<<5)-h);
    var hue=coverHues[Math.abs(h)%coverHues.length];
    var g=ctx.createLinearGradient(0,0,W,H);
    g.addColorStop(0,'hsl('+hue+',28%,32%)');g.addColorStop(1,'hsl('+(hue+25)%360+',32%,22%)');
    ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
    ctx.fillStyle='rgba(255,255,255,.025)';for(var y=0;y<H;y+=3)ctx.fillRect(0,y,W,1);
    ctx.strokeStyle='rgba(255,255,255,.1)';ctx.lineWidth=1;ctx.strokeRect(12,12,W-24,H-24);
    ctx.fillStyle='rgba(255,255,255,.88)';ctx.textAlign='center';ctx.textBaseline='middle';
    var fs=title.length<=4?28:title.length<=8?22:title.length<=14?17:13;
    ctx.font='bold '+fs+'px "LXGW WenKai TC","LXGW WenKai","Noto Serif SC",serif';
    var lines=[],line='';
    for(var j=0;j<title.length;j++){var t=line+title[j];if(ctx.measureText(t).width>120){lines.push(line);line=title[j]}else line=t}
    if(line)lines.push(line);
    var startY=H/2-(lines.length*(fs+6))/2;
    for(var k=0;k<Math.min(lines.length,6);k++)ctx.fillText(lines[k],W/2,startY+k*(fs+6));
    var sepY=startY+Math.min(lines.length,6)*(fs+6)+14;
    ctx.strokeStyle='rgba(255,255,255,.18)';ctx.beginPath();ctx.moveTo(50,sepY);ctx.lineTo(110,sepY);ctx.stroke();
    var ext=name.split('.').pop().toUpperCase();
    ctx.font='9px sans-serif';ctx.fillStyle='rgba(255,255,255,.3)';ctx.fillText(ext,W/2,200);
    return c.toDataURL('image/jpeg',.72);
  }catch(e){return''}
}

/* ===== Settings ===== */
function loadSettings(){try{var d=JSON.parse(localStorage.getItem('jd_s'));if(d){S.theme=d.theme||'light';S.fontSize=d.fs||18;S.lineHeight=d.lh||1.85;S.padding=d.pad||'normal';S.textColor=d.tc||'';S.librarySort=d.bsSort||'recent';S.convSimp=d.convSimp===true;S.stickyHead=d.stickyHead!==false;S.pomoMin=d.pomoMin||25;S.libraryCat=d.bsCat||'__all__';S.davSyncMode=d.davSyncMode||'auto';S.transEngine=d.transEngine||'auto'}}catch(e){}S.transEnabled=isTransActive();}
function saveSettings(){try{localStorage.setItem('jd_s',JSON.stringify({theme:S.theme,fs:S.fontSize,lh:S.lineHeight,pad:S.padding,tc:S.textColor||'',bsSort:S.librarySort,convSimp:S.convSimp,stickyHead:S.stickyHead,pomoMin:S.pomoMin,bsCat:S.libraryCat,davSyncMode:S.davSyncMode||'auto',transEngine:S.transEngine}))}catch(e){}}
function loadHiddenShelf(){
  S.hiddenShelf=false;
  try{localStorage.removeItem('jd_hidden_shelf');localStorage.removeItem('jd_privacy')}catch(e){}
}
function toggleHiddenShelf(){
  S.hiddenShelf=!S.hiddenShelf;
  renderBookshelf();
  toast(S.hiddenShelf?'已显示隐藏书架':'已返回常规书架');
}
function updateReaderTitle(){if(!reader||!reader.classList.contains('active')||!tbTitle||!S.fileName)return;tbTitle.textContent=S.fileName.replace(/\.[^.]+$/,'')}
/* ===== 繁简转换（繁体→简体逐字映射，非翻译） ===== */
function convText(str){return S.convSimp&&window.Convert?Convert.t2s(str):str}
function setConv(on){
  if(S.convSimp===!!on)return;
  S.convSimp=!!on;
  saveSettings();
  updateConvBtn();
  if(reader.classList.contains('active')&&S.chapters.length){
    closeSearch();
    var off=getChapterOffset();
    initSeamless(S.currentChapter,off);
  }
  toast(S.convSimp?'已转为简体显示':'已恢复原文');
}
function updateConvBtn(){
  var sw=$('switch-conv');
  if(sw)sw.checked=!!S.convSimp;
}
function applySettings(){
  document.documentElement.setAttribute('data-theme',S.theme);
  if(S.textColor){document.documentElement.style.setProperty('--reader-text',S.textColor)}
  else{document.documentElement.style.removeProperty('--reader-text')}
  if(contentInner){
    contentInner.style.fontSize=S.fontSize+'px';
    contentInner.style.lineHeight=S.lineHeight;
    contentInner.style.padding=({narrow:'40px 16px 100px',normal:'60px 24px 100px',wide:'80px 48px 100px'})[S.padding]||'60px 24px 100px';
    contentInner.style.color=S.textColor||'';
  }
  document.querySelectorAll('.ch-body[data-epub]').forEach(function(el){
    el.style.fontSize=S.fontSize+'px';
    el.style.lineHeight=S.lineHeight;
    el.style.color=S.textColor||'';
  });
  var rf=$('range-fs'),vf=$('val-fs'),rl=$('range-lh'),vl=$('val-lh');
  if(rf)rf.value=S.fontSize;if(vf)vf.textContent=S.fontSize+'px';
  if(rl)rl.value=S.lineHeight;if(vl)vl.textContent=S.lineHeight.toFixed(2);
  document.querySelectorAll('[data-pad]').forEach(function(b){b.classList.toggle('active',b.dataset.pad===S.padding)});
  document.querySelectorAll('[data-color]').forEach(function(b){
    var c=b.getAttribute('data-color')||'';
    b.classList.toggle('active',c===(S.textColor||''));
  });
  updateConvBtn();
  var sh=$('sticky-head');if(sh)sh.style.display=S.stickyHead?'block':'none';
  var rp=$('range-pomo'),vp=$('val-pomo');if(rp)rp.value=S.pomoMin;if(vp)vp.textContent=S.pomoMin+' 分钟';
  var ss=$('switch-sticky');if(ss)ss.checked=!!S.stickyHead;
  var selSync=$('select-dav-sync');if(selSync)selSync.value=S.davSyncMode||'auto';
  var swTr=$('switch-trans');if(swTr)swTr.checked=isTransActive();
  var seTr=$('select-trans-engine');if(seTr)seTr.value=S.transEngine||'auto';
  updateRepSwitch();
  updateTransUI();
}

/* ===== Bookshelf UI ===== */
function renderBookshelf(){
  var lib=getLib(),grid=$('bs-grid'),empty=$('bs-empty');
  /* 分类下拉同步 */
  var cats=getCats(),catSel=$('bs-cat');
  if(catSel){
    var opts='<option value="__all__">全部标签</option><option value="">未分类</option>'+cats.map(function(c){return'<option value="'+esc(c.n)+'">'+esc(c.n)+'</option>'}).join('');
    if(catSel.innerHTML!==opts)catSel.innerHTML=opts;
    catSel.value=S.libraryCat;
  }
  var query=bookshelfSearch?bookshelfSearch.value.trim().toLowerCase():'';
  var visibleLib=lib.filter(function(b){return!!b.pv===S.hiddenShelf});
  if(bookshelfSort)bookshelfSort.value=S.librarySort;
  if(bookshelfTools)bookshelfTools.style.display=lib.length?'flex':'none';
  if(query)visibleLib=visibleLib.filter(function(b){return b.n.toLowerCase().indexOf(query)>=0});
  if(S.libraryCat&&S.libraryCat!=='__all__')visibleLib=visibleLib.filter(function(b){return(b.cat||'')===S.libraryCat});
  if(!visibleLib.length){
    grid.style.display='none';empty.style.display='flex';
    var emptyText=empty.querySelector('p');var emptyHint=empty.querySelector('.bs-empty-hint');
    if(query){if(emptyText)emptyText.textContent='没有匹配的书籍';if(emptyHint)emptyHint.textContent='试试书名中的其他关键词'}
    else if(S.libraryCat&&S.libraryCat!=='__all__'){if(emptyText)emptyText.textContent='该标签下暂无书籍';if(emptyHint)emptyHint.textContent='鼠标悬停书籍卡片，点击标签按钮设置标签'}
    else{if(emptyText)emptyText.textContent='书架空空如也';if(emptyHint)emptyHint.textContent='点击左上角导入或拖拽文件到此处'}
    return;
  }
  grid.style.display='grid';empty.style.display='none';
  visibleLib.sort(function(a,b){
    if(S.librarySort==='title')return a.n.localeCompare(b.n,'zh-CN');
    if(S.librarySort==='progress')return getBookPct(b.n)-getBookPct(a.n)||(b.ts||0)-(a.ts||0);
    return(b.ts||0)-(a.ts||0);
  });
  var dirty=false;
  for(var di=0;di<visibleLib.length;di++){if(!visibleLib[di].cv){visibleLib[di].cv=generateCoverDataUrl(visibleLib[di].n);dirty=true}}
  if(dirty)saveLib(lib);
  grid.innerHTML=visibleLib.map(function(b,i){
    var title=b.n.replace(/\.[^.]+$/,'');
    var pct=getBookPct(b.n);
    var cv=b.cv;
    var dt=new Date(b.ts);var ds=(dt.getMonth()+1)+'/'+dt.getDate();
    var meta=fmtSize(b.s||0)+' · '+ds+(pct?' · '+pct+'%':'');
    var cc=b.cat?catColor(b.cat):'';
    var badges=[];
    if(b.src==='webdav'){
      badges.push('<span class="bs-card-dav" title="WebDAV 云端同步"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:2px"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>云端</span>');
    }
    if(b.cat){
      badges.push('<span class="bs-card-badge"'+(cc?' style="background:'+cc+'1a;color:'+cc+'"':'')+'>'+esc(b.cat)+'</span>');
    }
    var tagHtml=badges.length?'<div class="bs-card-tags">'+badges.join('')+'</div>':'';
    var tpBadge=b.tp==='epub'?'EPUB':b.tp==='md'?'MD':'TXT';
    return '<article class="bs-card" data-name="'+esc(b.n)+'" style="animation-delay:'+i*.04+'s">' +
      '<button type="button" class="bs-card-open" aria-label="阅读 '+esc(title)+'">' +
      '<div class="bs-card-cover"><img class="bs-card-img" src="'+cv+'" alt="" loading="lazy">' +
      '<div class="bs-card-pbar"><div class="bs-card-pfill" style="width:'+pct+'%"></div></div></div>' +
      '<div class="bs-card-info"><div class="bs-card-name" title="'+esc(b.n)+'">'+esc(title)+'</div>' +
      '<div class="bs-card-meta">'+meta+'</div>'+tagHtml+'</div></button>' +
      '<button type="button" class="bs-card-download" title="下载书籍" aria-label="下载 '+esc(title)+'"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg></button>' +
      '<button type="button" class="bs-card-cat" title="设置标签" aria-label="设置标签 '+esc(title)+'"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg></button>' +
      '<button type="button" class="bs-card-del" title="删除" aria-label="删除 '+esc(title)+'"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></article>';
  }).join('');
}
function getBookPct(n){try{var p=JSON.parse(localStorage.getItem('jd_p')||'{}')[n];return p&&p.pct?p.pct:0}catch(e){return 0}}
function showBookshelf(){
  if(S.fileName){
    saveProg();stopReadingTimer();closeSearch();togglePanel('sidebar',false);togglePanel('settings',false);
    if(_syncDebounceTimer){clearTimeout(_syncDebounceTimer);_syncDebounceTimer=null}
    /* checkpoint 上传：远程书关书时处理同步策略（auto: 自动静默同步，无弹窗打扰；ask: 弹窗确认；off: 不同步） */
    if(isCurrentBookWebdav(S.fileName)){
      var name=S.fileName;
      var mode=S.davSyncMode||'auto';
      if(mode==='auto'){
        davUploadCheckpoint(name,function(ok,msg){
          if(ok)toast('进度与笔记已同步');
          else console.warn('远端同步未成功: '+(msg||''));
        });
      }else if(mode==='ask'){
        confirmBox('是否将阅读进度与笔记同步到远端？','同步到远端',function(){
          toast('正在同步...');
          davUploadCheckpoint(name,function(ok,msg){
            toast(ok?'已同步到远端':'同步失败'+(msg?'：'+msg:''));
          });
        });
      }
    }
    S.fileName='';
  }
  clearBookCache();
  clearEpubCSS();closeTip();hideSelToolbar();hideAntPop();closeCatPop();_selCache=null;reader.classList.remove('active');bookshelf.classList.remove('hide');renderBookshelf();
}
function hideBookshelf(){bookshelf.classList.add('hide')}

/* ===== File Handling ===== */
function handleFile(f){
  if(!f)return;
  clearBookCache();
  var ext=f.name.split('.').pop().toLowerCase();
  if(['txt','md','markdown','epub'].indexOf(ext)<0){toast('暂不支持此格式');return}
  if(ext==='epub'){handleEPUB(f);return}
  S.fileName=f.name;S.fileSize=f.size;S.fileType=(ext==='md'||ext==='markdown')?'md':'txt';
  S.epubTitle='';S.toc=null;S.epubCSS='';
  showLoading('正在读取文件...');
  var rd=new FileReader();
  rd.onprogress=function(e){if(e.lengthComputable)showLoading('正在读取... '+fmtSize(e.loaded)+' / '+fmtSize(e.total))};
  rd.onerror=function(){toast('文件读取失败');hideLoading()};
  rd.onload=function(e){
    showLoading('正在解析内容...');
    var buf=e.target.result;
    setTimeout(function(){
      try{
        S.rawText=decodeBuffer(buf);
        var cv=generateCoverDataUrl(f.name);
        dbSave(S.fileName,{text:S.rawText,type:S.fileType,size:S.fileSize,cover:cv},function(){addToLib(S.fileName,S.fileSize,S.fileType,cv)});
        processContent();
      }catch(err){console.error(err);toast('文件解析失败: '+err.message);hideLoading()}
    },PROC_DELAY);
  };
  rd.readAsArrayBuffer(f);
}
function handleEPUB(f){
  S.fileName=f.name;S.fileSize=f.size;S.fileType='epub';
  showLoading('正在解析 EPUB...');
  var rd=new FileReader();
  rd.onprogress=function(e){if(e.lengthComputable)showLoading('正在读取... '+fmtSize(e.loaded)+' / '+fmtSize(e.total))};
  rd.onerror=function(){toast('文件读取失败');hideLoading()};
  rd.onload=function(e){
    showLoading('正在解析章节...');
    parseEPUB(e.target.result,function(result,err){
      if(err||!result){hideLoading();toast('EPUB 解析失败: '+(err||'未知错误'));return}
      finishEpubImport(f.name,f.size,result,f);
    });
  };
  rd.readAsArrayBuffer(f);
}
function finishEpubImport(name,size,result,source,src){
  S.rawText='';
  S.epubCSS=result.epubCSS||'';
  S.epubTitle=result.title||name.replace(/\.[^.]+$/,'');
  S.toc=result.toc||null;
  showLoading('正在清洗内容...');
  sanitizeChaptersForSave(result.chapters||[],function(clean){
    setChaptersFromMeta(clean.map(function(ch){
      return{title:ch.title,href:ch.href,textLen:ch.textLen,hasHtml:!!ch.html};
    }),'v2');
    /* 打开当前书时先把正文放进内存，再异步入库，避免首屏等 IDB */
    for(var i=0;i<clean.length;i++){
      S.chapters[i].html=clean[i].html;
      S.chapters[i].text=clean[i].text;
      S.chapters[i]._loaded=true;
      S.chapters[i]._sanitized=true;
    }
    var cv=result.cover||generateCoverDataUrl(name);
    var saveData={chapters:clean,type:'epub',size:size,cover:null,epubCSS:S.epubCSS,toc:S.toc,epubTitle:S.epubTitle,source:source||null};
    var doSave=function(c){
      saveData.cover=c;
      _idbPersistReady=false;
      dbSave(name,saveData,function(ok){
        _idbPersistReady=true;
        if(!ok)toast('缓存写入失败，阅读不受影响');
        else releaseChapterBodies();
        addToLib(name,size,'epub',c,src);
      });
      afterParseEPUB();
    };
    if(cv&&cv.indexOf('data:image')===0&&cv.length>5000){resizeCover(cv,160,224,function(small){doSave(small||cv)})}
    else{doSave(cv)}
  });
}
function afterParseEPUB(){
  _progData=null;_textCache=null;_textCacheLen=0;_searchToken++;
  if(!S.chapters||!S.chapters.length){
    S.chapters=[{title:'全文',content:S.rawText||'(空文件)',html:'',_loaded:true}];
    S.storeMode='inline';
  }
  var sv=loadProg(S.fileName);var sc=sv?Math.min(sv.ch,S.chapters.length-1):0;var so=sv?Math.max(0,sv.offset||0):0;
  S.searchQuery='';S.searchResults=[];S.searchIdx=-1;
  renderBookmarks();showReader();initSeamless(sc,so);
}
function setChaptersFromMeta(metaList,mode){
  S.storeMode=mode||'v2';
  S.chapters=(metaList||[]).map(function(m){
    return{
      title:m.title||'',
      href:m.href||'',
      textLen:m.textLen||1,
      hasHtml:!!m.hasHtml,
      html:null,
      text:null,
      content:'',
      _loaded:false,
      _sanitized:mode==='v2'
    };
  });
}
function setChaptersLegacy(list){
  S.storeMode='legacy';
  S.chapters=(list||[]).map(function(ch){
    var text=ch.text||ch.content||'';
    return{
      title:ch.title||'',
      href:ch.href||'',
      html:ch.html||'',
      text:text,
      content:text,
      textLen:Math.max(1,text.length||(ch.html?ch.html.length:1)),
      _loaded:true,
      _sanitized:false
    };
  });
}
function resizeCover(dataUrl,mw,mh,cb){
  var img=new Image();
  img.onload=function(){
    var dpr=Math.max(1,window.devicePixelRatio||1);
    var c=document.createElement('canvas');
    var r=Math.min(mw/img.width,mh/img.height);
    c.width=Math.round(img.width*r*dpr);c.height=Math.round(img.height*r*dpr);
    var ctx=c.getContext('2d');ctx.scale(dpr,dpr);
    ctx.drawImage(img,0,0,Math.round(img.width*r),Math.round(img.height*r));
    cb(c.toDataURL('image/jpeg',.72));
  };
  img.onerror=function(){cb(null)};
  img.src=dataUrl;
}
function decodeBuffer(buf){
  try{return new TextDecoder('utf-8',{fatal:true}).decode(buf)}
  catch(e){try{return new TextDecoder('gbk').decode(buf)}catch(e2){return new TextDecoder('utf-8',{fatal:false}).decode(buf)}}
}
function loadBookFromShelf(name){
  showLoading('正在加载...');
  clearBookCache();
  dbLoad(name,function(data){
    if(!data){hideLoading();toast('书籍数据已失效，请重新导入');return}
    S.fileName=name;S.fileSize=data.size||0;S.fileType=data.type||'txt';
    _idbPersistReady=true;
    /* checkpoint 下载：检测远端进度与笔记，若大于本地则提示跳转 */
    var lib=getLib(),isRemote=false,bookIdx=-1;
    for(var i=0;i<lib.length;i++){
      if(lib[i].n===name){
        bookIdx=i;
        if(lib[i].src==='webdav')isRemote=true;
        break;
      }
    }
    if(davSyncAvailable()&&(isRemote||bookIdx>=0)){
      var localProg=loadProg(name);
      davDownloadCheckpoint(name,function(remote){
        if(remote){
          if(!isRemote&&bookIdx>=0){
            lib[bookIdx].src='webdav';
            saveLib(lib);
            isRemote=true;
          }
          if((remote.bm&&remote.bm.length)||(remote.delBm&&remote.delBm.length)){
            try{
              var curBm=JSON.parse(localStorage.getItem('jd_bm_'+name)||'[]');
              var mergedBm=mergeBookmarks(name,curBm,remote.bm||[],remote.delBm||[]);
              localStorage.setItem('jd_bm_'+name,JSON.stringify(mergedBm));
            }catch(e){}
          }
          if((remote.ant&&remote.ant.length)||(remote.delAnt&&remote.delAnt.length)){
            try{
              var curAnt=JSON.parse(localStorage.getItem('jd_ant_'+name)||'[]');
              var mergedAnt=mergeAnnotations(name,curAnt,remote.ant||[],remote.delAnt||[]);
              localStorage.setItem('jd_ant_'+name,JSON.stringify(mergedAnt));
            }catch(e){}
          }
          if((remote.hl&&remote.hl.length)||(remote.delHl&&remote.delHl.length)){
            try{
              var curHl=JSON.parse(localStorage.getItem('jd_hl_'+name)||'[]');
              var mergedHl=mergeHlList(name,curHl,remote.hl||[],remote.delHl||[]);
              localStorage.setItem('jd_hl_'+name,JSON.stringify(mergedHl));
              if(S.fileName===name)_hlList=mergedHl;
            }catch(e){}
          }
          if((remote.rep&&remote.rep.length)||(remote.delRep&&remote.delRep.length)){
            try{
              var curRep=JSON.parse(localStorage.getItem('jd_rep_'+name)||'[]');
              var mergedRep=mergeRepRules(name,curRep,remote.rep||[],remote.delRep||[]);
              localStorage.setItem('jd_rep_'+name,JSON.stringify(mergedRep));
              if(S.fileName===name)_repList=mergedRep;
            }catch(e){}
          }
          if(remote.prog){
            if(!localProg){
              davApplyRemoteData(name,remote);
            }else if(davRemoteAhead(localProg,remote.prog)){
              confirmBox('检测到远端进度更靠前（第'+(remote.prog.ch+1)+'章 '+Math.round(remote.prog.pct||0)+'%），是否跳转？','跳转到远端进度',function(){
                davApplyRemoteData(name,remote);
                setTimeout(function(){
                  var np=loadProg(name);
                  if(np&&window.J){
                    window.J.go(np.ch||0,Math.max(0,np.offset||0));
                  }
                },500);
              });
            }
          }
        }
        _loadBookContinue(name,data);
      });
    }else{
      _loadBookContinue(name,data);
    }
  });
}
function _loadBookContinue(name,data){
    if(data.type==='epub'&&(data.chaptersMeta||data.chapters)){
      S.rawText='';
      S.epubCSS=data.epubCSS||'';
      S.epubTitle=data.epubTitle||name.replace(/\.[^.]+$/,'');
      S.toc=data.toc||null;
      if(data.v===2&&data.chaptersMeta&&data.chaptersMeta.length){
        setChaptersFromMeta(data.chaptersMeta,'v2');
      }else if(data.chapters&&data.chapters.length){
        setChaptersLegacy(data.chapters);
      }else{
        hideLoading();toast('书籍数据不完整，请重新导入');return;
      }
      touchLib(name);afterParseEPUB();
    }else{
      S.rawText=data.text||'';
      S.epubTitle='';S.toc=null;S.storeMode='inline';
      touchLib(name);processContent();
    }
}
function deleteBook(name){
  var t=name.replace(/\.[^.]+$/,'');
  var isRemote=false,lib0=getLib();
  for(var ri=0;ri<lib0.length;ri++){if(lib0[ri].n===name){isRemote=lib0[ri].src==='webdav';break}}
  confirmBox('确定要完全移除《'+t+'》？','移除',function(){
    dbDelete(name,function(){});removeFromLib(name);
    try{var p=JSON.parse(localStorage.getItem('jd_p')||'{}');delete p[name];localStorage.setItem('jd_p',JSON.stringify(p))}catch(e){console.warn('清除进度失败',e)}
    try{localStorage.removeItem('jd_bm_'+name)}catch(e){console.warn('清除书签失败',e)}
    try{localStorage.removeItem('jd_ant_'+name)}catch(e){console.warn('清除划线失败',e)}
    try{localStorage.removeItem('jd_del_bm_'+name)}catch(e){}
    try{localStorage.removeItem('jd_del_ant_'+name)}catch(e){}
    try{localStorage.removeItem('jd_del_hl_'+name)}catch(e){}
    try{localStorage.removeItem('jd_del_rep_'+name)}catch(e){}
    try{localStorage.removeItem('jd_hl_'+name)}catch(e){}
    try{localStorage.removeItem('jd_rep_'+name)}catch(e){}
    if(S.fileName===name){clearBookCache();S.fileName=''}
    renderBookshelf();toast('已从书架移除');
    if(isRemote&&window.WebDAV&&window.WebDAV.syncDeleteBook){
      window.WebDAV.syncDeleteBook(name).then(function(resp){
        if(resp&&resp.ok)toast('已同步删除远端配置');
        else toast('远端配置删除失败（网络或权限），可能残留在服务器');
      }).catch(function(){toast('远端配置删除失败（网络或权限），可能残留在服务器')});
    }
  });
}

/* ===== WebDAV checkpoint 同步（.easydu 隐藏目录） ===== */
function davSyncAvailable(){return!!(window.WebDAV&&window.WebDAV.syncEnabled&&window.WebDAV.syncEnabled())}

function isCurrentBookWebdav(name){
  var n=name||S.fileName;
  if(!n)return false;
  var lib=getLib();
  for(var i=0;i<lib.length;i++){
    if(lib[i].n===n&&lib[i].src==='webdav')return true;
  }
  return false;
}

function getBmSig(b){
  return (b.ch||0)+'_'+Math.round(b.offset||0);
}

function getAntSig(a){
  return (a.ch||0)+'_'+(a.start||0)+'_'+(a.end||0);
}

function mergeBookmarks(name,localList,remoteList,remoteDel){
  var localDel=[];
  try{localDel=JSON.parse(localStorage.getItem('jd_del_bm_'+name)||'[]')}catch(e){}
  var allDel=(localDel||[]).concat(remoteDel||[]);
  var delMap={};
  for(var d=0;d<allDel.length;d++){
    var item=allDel[d];
    if(item&&item.sig)delMap[item.sig]=Math.max(delMap[item.sig]||0,item.ts||0);
  }
  var merged=[],seen={};
  var candidates=(localList||[]).concat(remoteList||[]);
  for(var i=0;i<candidates.length;i++){
    var c=candidates[i];
    if(!c)continue;
    var sig=getBmSig(c);
    var delTime=delMap[sig];
    if(delTime&&delTime>=(c.ts||0))continue;
    if(!seen[sig]){
      seen[sig]=c;
      merged.push(c);
    }else{
      if((c.ts||0)>(seen[sig].ts||0)){
        seen[sig]=c;
        for(var m=0;m<merged.length;m++){
          if(getBmSig(merged[m])===sig){merged[m]=c;break}
        }
      }
    }
  }
  merged.sort(function(a,b){
    if(a.ch!==b.ch)return a.ch-b.ch;
    return (a.offset||0)-(b.offset||0);
  });
  try{localStorage.setItem('jd_del_bm_'+name,JSON.stringify(allDel.slice(-50)))}catch(e){}
  return merged;
}

function mergeAnnotations(name,localList,remoteList,remoteDel){
  var localDel=[];
  try{localDel=JSON.parse(localStorage.getItem('jd_del_ant_'+name)||'[]')}catch(e){}
  var allDel=(localDel||[]).concat(remoteDel||[]);
  var delMap={};
  for(var d=0;d<allDel.length;d++){
    var item=allDel[d];
    if(item&&item.sig)delMap[item.sig]=Math.max(delMap[item.sig]||0,item.ts||0);
  }
  var merged=[],seen={};
  var candidates=(localList||[]).concat(remoteList||[]);
  for(var i=0;i<candidates.length;i++){
    var c=candidates[i];
    if(!c)continue;
    var sig=getAntSig(c);
    var delTime=delMap[sig];
    if(delTime&&delTime>=(c.u||c.ts||0))continue;
    if(!seen[sig]){
      seen[sig]=c;
      merged.push(c);
    }else{
      var prev=seen[sig];
      var prevTime=prev.u||prev.ts||0;
      var curTime=c.u||c.ts||0;
      if(curTime>prevTime){
        seen[sig]=c;
        for(var m=0;m<merged.length;m++){
          if(getAntSig(merged[m])===sig){merged[m]=c;break}
        }
      }else if(c.note&&!prev.note){
        prev.note=c.note;
      }
    }
  }
  merged.sort(function(a,b){
    if(a.ch!==b.ch)return a.ch-b.ch;
    return (a.start||0)-(b.start||0);
  });
  try{localStorage.setItem('jd_del_ant_'+name,JSON.stringify(allDel.slice(-50)))}catch(e){}
  return merged;
}

function mergeHlList(name,localList,remoteList,remoteDel){
  var localDel=[];
  try{localDel=JSON.parse(localStorage.getItem('jd_del_hl_'+name)||'[]')}catch(e){}
  var allDel=(localDel||[]).concat(remoteDel||[]);
  var delMap={};
  for(var d=0;d<allDel.length;d++){
    var item=allDel[d];
    if(item&&item.w)delMap[item.w]=Math.max(delMap[item.w]||0,item.ts||0);
  }
  var merged=[],seen={};
  var candidates=(localList||[]).concat(remoteList||[]);
  for(var i=0;i<candidates.length;i++){
    var c=candidates[i];
    if(!c||!c.w)continue;
    var w=c.w.trim();
    if(!w)continue;
    var delTime=delMap[w];
    if(delTime&&delTime>=(c.ts||0))continue;
    if(!seen[w]){
      seen[w]=c;
      merged.push(c);
    }else{
      var prev=seen[w];
      if((c.ts||0)>(prev.ts||0)){
        seen[w]=c;
        for(var m=0;m<merged.length;m++){
          if(merged[m].w===w){merged[m]=c;break}
        }
      }
    }
  }
  try{localStorage.setItem('jd_del_hl_'+name,JSON.stringify(allDel.slice(-50)))}catch(e){}
  return merged;
}

function mergeRepRules(name,localList,remoteList,remoteDel){
  var localDel=[];
  try{localDel=JSON.parse(localStorage.getItem('jd_del_rep_'+name)||'[]')}catch(e){}
  var allDel=(localDel||[]).concat(remoteDel||[]);
  var delMap={};
  for(var d=0;d<allDel.length;d++){
    var item=allDel[d];
    if(item&&item.f)delMap[item.f]=Math.max(delMap[item.f]||0,item.ts||0);
  }
  var merged=[],seen={};
  var candidates=(localList||[]).concat(remoteList||[]);
  for(var i=0;i<candidates.length;i++){
    var c=candidates[i];
    if(!c||!c.f)continue;
    var f=c.f;
    var delTime=delMap[f];
    if(delTime&&delTime>=(c.ts||0))continue;
    if(!seen[f]){
      seen[f]=c;
      merged.push(c);
    }else{
      var prev=seen[f];
      if((c.ts||0)>(prev.ts||0)){
        seen[f]=c;
        for(var m=0;m<merged.length;m++){
          if(merged[m].f===f){merged[m]=c;break}
        }
      }
    }
  }
  try{localStorage.setItem('jd_del_rep_'+name,JSON.stringify(allDel.slice(-50)))}catch(e){}
  return merged;
}

/* 上传当前书的阅读进度、书签、批注、高亮词和替换规则到远端 */
function davUploadCheckpoint(name,cb,opts){
  if(!davSyncAvailable()){if(cb)cb(false,'未连接');return}
  var prog=loadProg(name)||null;
  var bm=[],ant=[],delBm=[],delAnt=[];
  var hl=[],rep=[],delHl=[],delRep=[];
  try{bm=JSON.parse(localStorage.getItem('jd_bm_'+name)||'[]')}catch(e){bm=[]}
  try{ant=JSON.parse(localStorage.getItem('jd_ant_'+name)||'[]')}catch(e){ant=[]}
  try{delBm=JSON.parse(localStorage.getItem('jd_del_bm_'+name)||'[]')}catch(e){delBm=[]}
  try{delAnt=JSON.parse(localStorage.getItem('jd_del_ant_'+name)||'[]')}catch(e){delAnt=[]}
  try{hl=JSON.parse(localStorage.getItem('jd_hl_'+name)||'[]')}catch(e){hl=[]}
  try{rep=JSON.parse(localStorage.getItem('jd_rep_'+name)||'[]')}catch(e){rep=[]}
  try{delHl=JSON.parse(localStorage.getItem('jd_del_hl_'+name)||'[]')}catch(e){delHl=[]}
  try{delRep=JSON.parse(localStorage.getItem('jd_del_rep_'+name)||'[]')}catch(e){delRep=[]}
  var payload={v:2,ts:Date.now(),prog:prog,bm:bm,ant:ant,delBm:delBm,delAnt:delAnt,hl:hl,rep:rep,delHl:delHl,delRep:delRep};
  window.WebDAV.syncSaveBook(name,payload,opts).then(function(r){
    if(r&&r.ok)cb&&cb(true);
    else cb&&cb(false,'HTTP '+(r?r.status:'无响应'));
  }).catch(function(e){cb&&cb(false,String(e))});
}
/* 下载远端书配置，返回数据对象或 null */
function davDownloadCheckpoint(name,cb){
  if(!davSyncAvailable()){cb(null);return}
  window.WebDAV.syncLoadBook(name).then(function(r){
    if(r&&r.ok&&r.data&&r.data.v)cb(r.data);
    else cb(null);
  }).catch(function(){cb(null)});
}
/* 将远端阅读进度应用到本地 */
function davApplyRemoteData(name,d){
  try{
    if(d&&d.prog!==undefined){
      var p=JSON.parse(localStorage.getItem('jd_p')||'{}');
      if(d.prog)p[name]=d.prog;else delete p[name];
      localStorage.setItem('jd_p',JSON.stringify(p));
    }
    return true;
  }catch(e){console.warn('应用远端进度失败',e);return false}
}
/* 比较远端进度是否大于本地（ch 更大，或 ch 相同 pct 更大） */
function davRemoteAhead(local,remote){
  if(!remote)return false;
  if(!local)return true;
  if((remote.ch||0)>(local.ch||0))return true;
  if((remote.ch||0)===(local.ch||0)&&(remote.pct||0)>(local.pct||0))return true;
  return false;
}

/* 阅读中防抖静默同步与切后台/息屏保底保存 */
var _syncDebounceTimer=null;
function triggerReadingDebouncedSync(delayMs){
  if(!isCurrentBookWebdav()||!davSyncAvailable()||S.davSyncMode==='off')return;
  if(_syncDebounceTimer)clearTimeout(_syncDebounceTimer);
  _syncDebounceTimer=setTimeout(function(){
    if(reader&&reader.classList.contains('active')&&S.fileName&&isCurrentBookWebdav()){
      saveProg();
      davUploadCheckpoint(S.fileName);
    }
  },delayMs||5000);
}

/* 离散改动立即同步（批注、笔记、替换规则、高亮词、书签改动时） */
function triggerImmediateSync(){
  if(!isCurrentBookWebdav()||!davSyncAvailable()||S.davSyncMode==='off')return;
  if(_syncDebounceTimer){clearTimeout(_syncDebounceTimer);_syncDebounceTimer=null}
  if(S.fileName){
    saveProg();
    davUploadCheckpoint(S.fileName,function(ok,msg){
      if(!ok)console.warn('立即同步未成功: '+(msg||''));
    });
  }
}

function handleBackgroundSync(){
  if(!reader||!reader.classList.contains('active')||!S.fileName)return;
  if(!isCurrentBookWebdav(S.fileName)||!davSyncAvailable()||S.davSyncMode==='off')return;
  saveProg();
  davUploadCheckpoint(S.fileName,null,{keepalive:true});
}
function triggerDownload(blob,name){
  var url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=name;a.style.display='none';document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(url)},1000);
}
function downloadBook(name){
  dbLoad(name,function(data){
    if(!data){toast('书籍数据已失效，请重新导入');return}
    if(data.source instanceof Blob){triggerDownload(data.source,name);toast('已开始下载');return}
    if(data.type!=='epub'){
      triggerDownload(new Blob([data.text||''],{type:'text/plain;charset=utf-8'}),name);
      toast('已开始下载');return;
    }
    /* 老版本未保存原始 EPUB 时，仍可将缓存中的章节正文导出为 TXT。 */
    var exportText=function(chapters){
      var parts=(chapters||[]).map(function(ch){
        var text=ch.text||ch.content||'';
        if(!text&&ch.html){try{text=new DOMParser().parseFromString(ch.html,'text/html').body.textContent||''}catch(e){text=''}}
        return(ch.title?ch.title+'\n\n':'')+text;
      });
      triggerDownload(new Blob([parts.join('\n\n')],{type:'text/plain;charset=utf-8'}),name.replace(/\.[^.]+$/,'.txt'));
      toast('原始 EPUB 未保留，已导出 TXT');
    };
    if(data.chapters&&data.chapters.length){exportText(data.chapters);return}
    var count=data.chaptersMeta?data.chaptersMeta.length:0,indices=[];
    for(var i=0;i<count;i++)indices.push(i);
    dbLoadChapters(name,indices,exportText);
  });
}
function processContent(){
  clearBookCache();
  S.storeMode='inline';
  if(S.fileType!=='epub'){
    S.chapters=S.fileType==='md'?splitMD(S.rawText):splitTxt(S.rawText);
    for(var pi=0;pi<S.chapters.length;pi++){
      S.chapters[pi]._loaded=true;
      S.chapters[pi].textLen=Math.max(1,(S.chapters[pi].content||'').length);
    }
  }
  _progData=null;
  if(!S.chapters||!S.chapters.length)S.chapters=[{title:'全文',content:S.rawText||'(空文件)',html:''}];
  var sv=loadProg(S.fileName);var sc=sv?Math.min(sv.ch,S.chapters.length-1):0;var so=sv?Math.max(0,sv.offset||0):0;
  S.searchQuery='';S.searchResults=[];S.searchIdx=-1;
  renderBookmarks();showReader();initSeamless(sc,so);
}

/* ===== Split ===== */
function splitTxt(t){
  if(!t||!t.trim())return[{title:'(空文件)',content:''}];
  var ps=[/^(第[一二三四五六七八九十百千万零\d]+[章节回折幕集卷部篇][^\n]*)/gm,/^(Chapter\s+\d+[^\n]*)/gmi,/^(卷[一二三四五六七八九十百千万零\d]+[^\n]*)/gm,/^(序[章言幕]|楔子|引子|尾声|后记|番外)[^\n]*/gm];
  var mk=[];
  for(var pi=0;pi<ps.length;pi++){var m;while((m=ps[pi].exec(t))!==null)mk.push({i:m.index,t:m[1].trim()})}
  if(!mk.length)return splitByPara(t);
  mk.sort(function(a,b){return a.i-b.i});var d=[mk[0]];
  for(var i=1;i<mk.length;i++){if(mk[i].i>d[d.length-1].i+CH_HEADING_GAP)d.push(mk[i])}
  var ch=[];
  if(d[0].i>0){var pre=t.slice(0,d[0].i).trim();if(pre)ch.push({title:'前言',content:pre})}
  for(var j=0;j<d.length;j++){var le=t.indexOf('\n',d[j].i);le=le<0?t.length:le+1;var e2=j+1<d.length?d[j+1].i:t.length;ch.push({title:d[j].t,content:t.slice(le,e2).trim()})}
  return ch;
}
function splitByPara(t){var ps=t.split(/\n\s*\n/),ch=[],buf='',idx=1;for(var i=0;i<ps.length;i++){if(buf.length+ps[i].length>PARA_MAX&&buf.length>0){ch.push({title:'段落 '+idx,content:buf.trim()});idx++;buf=ps[i]}else buf+=(buf?'\n\n':'')+ps[i]}if(buf.trim())ch.push({title:'段落 '+idx,content:buf.trim()});if(!ch.length&&t.trim())ch.push({title:'全文',content:t.trim()});return ch}
function splitMD(md){var lines=md.split('\n'),ch=[],cur=null;for(var i=0;i<lines.length;i++){var h=lines[i].match(/^(#{1,2})\s+(.+)/);if(h){if(cur&&cur.content.trim())ch.push(cur);cur={title:h[2].trim(),content:''}}else{if(!cur)cur={title:'',content:''};cur.content+=lines[i]+'\n'}}if(cur&&cur.content.trim())ch.push(cur);if(!ch.length)ch.push({title:S.fileName,content:md});var hm=typeof marked!=='undefined'&&marked.parse;for(var j=0;j<ch.length;j++)ch[j].html=hm?marked.parse(ch[j].content):null;return ch}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
var _dp=new DOMParser();
var CSS_XSS=/expression\s*\(|-moz-binding\s*:|behavior\s*:|@import|javascript\s*:/i;
var _ALLOWED_TAGS=/^(p|br|hr|h[1-6]|ul|ol|li|blockquote|pre|code|em|strong|b|i|u|s|a|span|div|table|thead|tbody|tr|td|th|img|sub|sup|small|mark|dl|dt|dd|figure|figcaption|section|article|header|footer|nav|aside|abbr|cite|dfn|kbd|samp|var|time|ruby|rt|rp|wbr|sup)$/i;
var _ALLOWED_ATTRS=/^(href|src|alt|title|class|id|style|type|colspan|rowspan|width|height|datetime|cite|dir|lang|role|aria-[\w-]+|epub:type|xml:lang)$/i;
var _UNSAFE_SCHEMES=/^\s*(?:javascript|vbscript):/i;
function sanitizeHTML(html){
  var doc=_dp.parseFromString(html,'text/html');
  var walker=document.createTreeWalker(doc.body,NodeFilter.SHOW_ELEMENT);
  var toRemove=[];
  while(walker.nextNode()){
    var el=walker.currentNode;
    if(!_ALLOWED_TAGS.test(el.tagName)){toRemove.push(el);continue}
    var attrs=Array.prototype.slice.call(el.attributes);
    for(var i=0;i<attrs.length;i++){
      var name=attrs[i].name.toLowerCase();
      if(!_ALLOWED_ATTRS.test(name)){el.removeAttribute(attrs[i].name);continue}
      if(name==='style'&&CSS_XSS.test(attrs[i].value)){el.removeAttribute(attrs[i].name);continue}
      if(_UNSAFE_SCHEMES.test(attrs[i].value)||(name==='href'&&/^\s*data:/i.test(attrs[i].value))){el.removeAttribute(attrs[i].name)}
    }
  }
  for(var j=toRemove.length-1;j>=0;j--){
    var parent=toRemove[j].parentNode;if(!parent)continue;
    while(toRemove[j].firstChild)parent.insertBefore(toRemove[j].firstChild,toRemove[j]);
    parent.removeChild(toRemove[j]);
  }
  return doc.body;
}
/* 导入时清洗为字符串，渲染时跳过二次 sanitize */
function sanitizeHTMLString(html){
  if(!html)return'';
  try{return sanitizeHTML(html).innerHTML}catch(e){return html}
}
function sanitizeChaptersForSave(chapters,onDone){
  if(!chapters||!chapters.length){onDone(chapters||[]);return}
  var out=new Array(chapters.length);
  var i=0,BATCH=25;
  function step(){
    var end=Math.min(i+BATCH,chapters.length);
    for(;i<end;i++){
      var ch=chapters[i]||{};
      var html=ch.html?sanitizeHTMLString(ch.html):'';
      var text=ch.text||ch.content||'';
      if(!text&&html){
        try{text=_dp.parseFromString('<div>'+html+'</div>','text/html').body.textContent||''}catch(e){text=''}
      }
      out[i]={title:ch.title||'',href:ch.href||'',html:html,text:text,textLen:Math.max(1,text.length)};
    }
    if(i<chapters.length){setTimeout(step,0);return}
    onDone(out);
  }
  step();
}
function txtToHtml(t){var ls=t.split(/\n/),h=[],inP=false,inBq=false,inUl=false,inOl=false;for(var i=0;i<ls.length;i++){var raw=ls[i],tr=raw.trim();if(!tr){closeTags();continue}var hm=tr.match(/^(#{1,3})\s(.+)/);if(hm){closeTags();h.push('<h'+hm[1].length+'>'+esc(hm[2])+'</h'+hm[1].length+'>');continue}var bqm=tr.match(/^>\s?(.+)/);if(bqm){if(inP){h.push('</p>');inP=false}if(!inBq){h.push('<blockquote>');inBq=true}h.push('<p>'+esc(bqm[1])+'</p>');continue}var ulm=tr.match(/^[-*+]\s(.+)/);if(ulm){closeInline();if(inOl){h.push('</ol>');inOl=false}if(!inUl){h.push('<ul>');inUl=true}h.push('<li>'+esc(ulm[1])+'</li>');continue}var olm=tr.match(/^\d+[.)]\s(.+)/);if(olm){closeInline();if(inUl){h.push('</ul>');inUl=false}if(!inOl){h.push('<ol>');inOl=true}h.push('<li>'+esc(olm[1])+'</li>');continue}closeInline();if(!inP){h.push('<p>');inP=true}h.push(esc(tr))}function closeTags(){if(inP){h.push('</p>');inP=false}if(inBq){h.push('</blockquote>');inBq=false}if(inUl){h.push('</ul>');inUl=false}if(inOl){h.push('</ol>');inOl=false}}function closeInline(){if(inP){h.push('</p>');inP=false}if(inBq){h.push('</blockquote>');inBq=false}}if(inP)h.push('</p>');if(inBq)h.push('</blockquote>');if(inUl)h.push('</ul>');if(inOl)h.push('</ol>');return h.join('')}

/* ===== Seamless Rendering ===== */
function injectEpubCSS(){
  var old=$('epub-styles');if(old)old.parentNode.removeChild(old);
  if(!S.epubCSS)return;
  var s=document.createElement('style');s.id='epub-styles';s.textContent=S.epubCSS;
  document.head.appendChild(s);
}
function clearEpubCSS(){var old=$('epub-styles');if(old)old.parentNode.removeChild(old)}
function createChapterBlock(idx){
  var ch=S.chapters[idx];if(!ch)return null;
  var d=document.createElement('div');d.className='ch-block';d.dataset.idx=idx;
  var hasHtml=!!(ch.html&&ch.html.length);
  var isEpub=S.fileType==='epub'||hasHtml;
  if(!isEpub){
    var t=document.createElement('h2');t.className='ch-title';t.textContent=ch.title||'';d.appendChild(t);
  }
  var b=document.createElement('div');b.className='ch-body';
  if(hasHtml){
    /* 已清洗入库则直接 innerHTML；legacy 仍 sanitize 一次 */
    if(ch._sanitized||S.storeMode==='v2'){
      b.innerHTML=ch.html;
    }else{
      var body=sanitizeHTML(ch.html);
      while(body.firstChild)b.appendChild(body.firstChild);
      ch._sanitized=true;
    }
    var firstH1=b.querySelector('h1');if(firstH1)firstH1.remove();
    var hCnt=0;b.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(function(h){if(!h.id)h.id='ch-'+idx+'-h-'+(hCnt++)});
    if(S.epubCSS){
      b.classList.add('epub-content');b.setAttribute('data-epub','');b.setAttribute('data-epub-has-css','');
      b.style.fontSize=S.fontSize+'px';b.style.lineHeight=S.lineHeight;if(S.textColor)b.style.color=S.textColor;
    }
  }else{
    b.innerHTML=txtToHtml(ch.content||ch.text||'');
  }
  d.appendChild(b);
  /* 繁简转换：统一对整块文本节点逐字转换（含章节标题，长度不变） */
  if(S.convSimp&&window.Convert){
    var w=document.createTreeWalker(d,NodeFilter.SHOW_TEXT),ns=[];
    while(w.nextNode())ns.push(w.currentNode);
    for(var ti=0;ti<ns.length;ti++){
      var nd=ns[ti],cv=Convert.t2s(nd.nodeValue);
      if(cv!==nd.nodeValue)nd.nodeValue=cv;
    }
  }
  /* 替换规则 + 高亮词着色（基于转换后的最终文本） */
  applyTextDecor(d);
  /* 划线笔记恢复（基于最终渲染文本的偏移基线） */
  var bodyEl=d.querySelector('.ch-body');
  if(bodyEl)applyAnnotations(bodyEl,idx);
  return d;
}
function createSep(){var d=document.createElement('div');d.className='ch-sep';d.innerHTML='<div class="ch-sep-dot"></div><div class="ch-sep-dot"></div><div class="ch-sep-dot"></div>';return d}
/* 局部重建单个章节块：替换 DOM 节点并保持视口稳定，避免整页刷新闪烁 */
function rerenderChapterBlock(idx){
  var old=contentInner.querySelector('.ch-block[data-idx="'+idx+'"]');
  if(!old)return;
  var cr=contentEl.getBoundingClientRect();
  var offset=old.getBoundingClientRect().top-cr.top;
  var nblk=createChapterBlock(idx);
  if(!nblk)return;
  old.parentNode.replaceChild(nblk,old);
  /* 新块若与视口顶部有位移差则补偿，保持阅读位置不跳 */
  var newOffset=nblk.getBoundingClientRect().top-cr.top;
  if(Math.abs(newOffset-offset)>1){
    isAdjusting=true;
    contentEl.scrollTop+=newOffset-offset;
    requestAnimationFrame(function(){isAdjusting=false;updateReadingChapter();updateProgress();highlightToc();updateBmBtn()});
  }else{
    updateReadingChapter();updateProgress();highlightToc();updateBmBtn();
  }
}
/* 重建所有已渲染章节块（替换规则/高亮词修改后），保持视口稳定 */
function rerenderAllBlocks(){
  if(!reader.classList.contains('active')||!S.chapters.length)return;
  closeSearch();
  var blocks=contentInner.querySelectorAll('.ch-block');
  if(!blocks.length)return;
  var anchor=null,offset=0,cr=contentEl.getBoundingClientRect();
  for(var i=0;i<blocks.length;i++){
    var r=blocks[i].getBoundingClientRect();
    if(r.bottom>cr.top){anchor=+blocks[i].dataset.idx;offset=r.top-cr.top;break}
  }
  if(anchor===null){anchor=+blocks[0].dataset.idx;offset=0}
  var oT=contentEl.scrollTop;
  contentInner.innerHTML='';
  for(var j=firstLoaded;j<=lastLoaded;j++){
    var blk=createChapterBlock(j);
    if(!blk)continue;
    if(contentInner.children.length>0)contentInner.appendChild(createSep());
    contentInner.appendChild(blk);
  }
  var target=contentInner.querySelector('.ch-block[data-idx="'+anchor+'"]');
  isAdjusting=true;
  if(target){
    var newOffset=target.getBoundingClientRect().top-cr.top;
    contentEl.scrollTop=oT+(newOffset-offset);
  }else{
    contentEl.scrollTop=oT;
  }
  requestAnimationFrame(function(){
    isAdjusting=false;
    updateReadingChapter();updateProgress();highlightToc();updateBmBtn();
  });
}
/* 相对 #content 的滚动偏移：offsetTop 在嵌套布局/transform 下不可靠，移动端更明显 */
function getContentOffset(el){
  if(!el||!contentEl)return 0;
  var er=el.getBoundingClientRect(),cr=contentEl.getBoundingClientRect();
  return er.top-cr.top+contentEl.scrollTop;
}
/* 等待图片/字体布局稳定后再定位，避免 EPUB 后几章因图片未加载导致错位 */
function whenLayoutReady(root,cb,timeout){
  var done=false,t=timeout||1200;
  function finish(){if(done)return;done=true;cb()}
  var imgs=root?root.querySelectorAll('img'):[];
  var pending=0;
  for(var i=0;i<imgs.length;i++){
    if(imgs[i].complete&&imgs[i].naturalWidth>0)continue;
    pending++;
    (function(img){
      var onDone=function(){img.removeEventListener('load',onDone);img.removeEventListener('error',onDone);pending--;if(pending<=0)finish()};
      img.addEventListener('load',onDone);img.addEventListener('error',onDone);
    })(imgs[i]);
  }
  if(document.fonts&&document.fonts.ready){document.fonts.ready.then(function(){if(pending<=0)finish()}).catch(function(){})}
  if(pending<=0){requestAnimationFrame(function(){requestAnimationFrame(finish)});return}
  setTimeout(finish,t);
}
function scrollToChapter(chapter,offset){
  var bl=contentInner.querySelector('[data-idx="'+chapter+'"]');
  if(!bl)return;
  isAdjusting=true;
  contentEl.scrollTop=getContentOffset(bl)+Math.max(0,offset||0);
  requestAnimationFrame(function(){isAdjusting=false});
}
function scrollToElement(el,pad){
  if(!el)return;
  isAdjusting=true;
  contentEl.scrollTop=Math.max(0,getContentOffset(el)-(pad||0));
  requestAnimationFrame(function(){isAdjusting=false});
}
function initSeamless(chapter,offset,after){
  contentInner.innerHTML='';firstLoaded=-1;lastLoaded=-1;injectEpubCSS();
  var st=Math.max(0,chapter-2),en=Math.min(S.chapters.length-1,chapter+2);
  S.currentChapter=chapter;
  isAdjusting=true;
  contentEl.scrollTop=0;
  ensureChapters(rangeIndices(st,en),function(){
    for(var i=st;i<=en;i++){
      var blk=createChapterBlock(i);if(!blk)continue;
      if(contentInner.children.length>0)contentInner.appendChild(createSep());
      contentInner.appendChild(blk);
      if(firstLoaded===-1)firstLoaded=i;lastLoaded=i;
    }
    function settle(){
      scrollToChapter(chapter,Math.max(0,offset||0));
      updateProgress();highlightToc();updateBmBtn();updateStickyHead();
      checkInfinite();schedulePreload();
      if(S.fileType==='epub'){processFootnotes();setupEpubLinkHandler()}
      releaseChapterBodies();
      if(typeof after==='function')after();
      /* after 可能滚动了精确位置（如进度条跳转），其滚动事件可能被 isAdjusting 拦截导致显示滞后，
         在下一帧强制刷新一次进度与章节，保证进度条与真实滚动位置一致 */
      requestAnimationFrame(function(){
        if(isAdjusting)isAdjusting=false;
        if(!reader.classList.contains('active'))return;
        updateReadingChapter();updateProgress();highlightToc();updateBmBtn();updateStickyHead();
      });
    }
    whenLayoutReady(contentInner,settle);
  });
}
var _chPending={};
function appendChapter(idx){
  if(idx>=S.chapters.length||idx<=lastLoaded||_chPending[idx])return;
  _chPending[idx]=1;
  ensureChapters([idx],function(){
    delete _chPending[idx];
    if(idx<=lastLoaded||idx!==lastLoaded+1)return;
    if(contentInner.children.length>0)contentInner.appendChild(createSep());
    var blk=createChapterBlock(idx);
    if(blk){
      contentInner.appendChild(blk);lastLoaded=idx;trimChapters();releaseChapterBodies();
      if(S.fileType==='epub'&&_ftTipEl)_scanFootnotes();
    }
  });
}
function prependChapter(idx){
  if(idx<0||idx>=firstLoaded||_chPending[idx])return;
  _chPending[idx]=1;
  ensureChapters([idx],function(){
    delete _chPending[idx];
    if(idx>=firstLoaded||idx!==firstLoaded-1)return;
    var oH=contentEl.scrollHeight,oT=contentEl.scrollTop;
    var bl=createChapterBlock(idx);if(!bl)return;
    var fc=contentInner.firstChild;
    if(fc){var s=createSep();contentInner.insertBefore(s,fc);contentInner.insertBefore(bl,s)}
    else contentInner.appendChild(bl);
    firstLoaded=idx;
    isAdjusting=true;
    contentEl.scrollTop=oT+(contentEl.scrollHeight-oH);
    requestAnimationFrame(function(){
      isAdjusting=false;trimChapters();releaseChapterBodies();
      if(S.fileType==='epub'&&_ftTipEl)_scanFootnotes();
    });
  });
}
function checkInfinite(){if(isAdjusting||!S.chapters.length)return;var st=contentEl.scrollTop,sb=st+contentEl.clientHeight,sh=contentEl.scrollHeight;if(sb>sh-SCROLL_BOUND&&lastLoaded<S.chapters.length-1)appendChapter(lastLoaded+1);if(st<SCROLL_BOUND&&firstLoaded>0)prependChapter(firstLoaded-1)}
var _preloadTimer=null;
function schedulePreload(){
  if(_preloadTimer)clearTimeout(_preloadTimer);
  _preloadTimer=setTimeout(function(){
    if(!S.chapters.length||!reader.classList.contains('active'))return;
    if(typeof requestIdleCallback!=='undefined'){
      requestIdleCallback(function(){doPreload()},{timeout:500});
    }else{doPreload()}
  },300);
}
function doPreload(){
  var cur=S.currentChapter,total=S.chapters.length;
  var need=[];
  for(var d=-2;d<=2;d++){
    var idx=cur+d;
    if(idx<0||idx>=total)continue;
    var el=contentInner.querySelector('[data-idx="'+idx+'"]');
    if(!el)need.push(idx);
  }
  if(!need.length){releaseChapterBodies();return}
  ensureChapters(need,function(){
    for(var i=0;i<need.length;i++){
      if(need[i]<firstLoaded)prependChapter(need[i]);
      else if(need[i]>lastLoaded)appendChapter(need[i]);
    }
    releaseChapterBodies();
  });
}
function trimChapters(){
  var min=Math.max(0,S.currentChapter-TRIM_WIN),max=Math.min(S.chapters.length-1,S.currentChapter+TRIM_WIN);
  if(firstLoaded>=min&&lastLoaded<=max)return;
  var oT=contentEl.scrollTop,oH=contentEl.scrollHeight;
  var blocks=contentInner.querySelectorAll('.ch-block');
  for(var i=blocks.length-1;i>=0;i--){
    var idx=+blocks[i].dataset.idx;
    if(idx<min||idx>max)blocks[i].parentNode.removeChild(blocks[i]);
  }
  var seps=contentInner.querySelectorAll('.ch-sep');
  for(var j=seps.length-1;j>=0;j--){
    if(!seps[j].parentNode)continue;
    var p=seps[j].previousElementSibling,n=seps[j].nextElementSibling;
    if(!p||!n||!p.classList.contains('ch-block')||!n.classList.contains('ch-block'))
      seps[j].parentNode.removeChild(seps[j]);
  }
  var rem=contentInner.querySelectorAll('.ch-block');
  if(!rem.length)return;
  firstLoaded=+rem[0].dataset.idx;lastLoaded=+rem[rem.length-1].dataset.idx;
  contentEl.scrollTop=Math.max(0,Math.min(contentEl.scrollHeight-contentEl.clientHeight,oT-(oH-contentEl.scrollHeight)));
}
function updateReadingChapter(){var bs=contentInner.querySelectorAll('.ch-block');var cr=contentEl.getBoundingClientRect();var threshold=cr.top+contentEl.clientHeight*.33;var c=S.currentChapter;for(var i=0;i<bs.length;i++){var rect=bs[i].getBoundingClientRect();if(rect.top>threshold)break;c=+bs[i].dataset.idx}if(c!==S.currentChapter){S.currentChapter=c;highlightToc();updateBmBtn();updateStickyHead();saveProg();triggerReadingDebouncedSync(5000)}}
var svTimer;function afterScroll(){if(isAdjusting)return;closeTip();hideSelToolbar();hideAntPop();updateReadingChapter();updateProgress();checkInfinite();updateBmBtn();clearTimeout(svTimer);svTimer=setTimeout(function(){saveProg();schedulePreload();if(reader&&reader.classList.contains('active')&&S.fileName&&isCurrentBookWebdav()&&S.davSyncMode!=='off'&&davSyncAvailable()){triggerReadingDebouncedSync(10000)}},SAVE_DELAY)}

/* ===== Progress ===== */
function getProgressData(){
  if(_progData&&_progData.len===S.chapters.length)return _progData;
  var total=0,cum=[0];
  for(var i=0;i<S.chapters.length;i++){
    var ch=S.chapters[i];
    var len=ch.textLen||(ch._loaded?getChText(ch,i).length:0)||1;
    total+=Math.max(1,len);
    cum.push(total);
  }
  _progData={cum:cum,total:total,len:S.chapters.length};
  return _progData;
}
function getAccurateProgress(){if(!S.chapters||!S.chapters.length)return 0;var pd=getProgressData();if(!pd.total)return 0;var bl=contentInner.querySelector('[data-idx="'+S.currentChapter+'"]');if(!bl)return pd.cum[S.currentChapter]/pd.total;var cs=pd.cum[S.currentChapter],cl=pd.cum[S.currentChapter+1]-cs;var so=contentEl.scrollTop-getContentOffset(bl),cp=bl.offsetHeight>0?Math.max(0,Math.min(1,so/bl.offsetHeight)):0;return(cs+cl*cp)/pd.total}
function positionProgressTip(pi){
  /* tip 中心对齐进度点，但限制在轨道内，避免 0%/100% 时溢出屏幕 */
  if(!progressTip||!progressTrack)return;
  var tipW=progressTip.offsetWidth||120;
  var trackW=progressTrack.clientWidth||1;
  if(tipW>=trackW){progressTip.style.left='50%';return}
  var x=pi/100*trackW;
  x=Math.max(tipW/2,Math.min(trackW-tipW/2,x));
  progressTip.style.left=x+'px';
}
function updateProgress(){var pct=getAccurateProgress(),pi=Math.round(pct*100);progressFill.style.width=pi+'%';progressThumb.style.left=pi+'%';var ch=S.chapters[S.currentChapter];progressTip.textContent=(ch?ch.title:'')+' · '+pi+'%';positionProgressTip(pi)}
function jumpToPercent(pct){var pd=getProgressData();if(!pd.total)return;var tc=pct*pd.total,ci=0;for(var i=0;i<pd.cum.length-1;i++){if(pd.cum[i+1]>=tc){ci=i;break}ci=i+1}ci=Math.min(ci,S.chapters.length-1);var cs=pd.cum[ci],cl=pd.cum[ci+1]-cs,cp2=cl>0?(tc-cs)/cl:0;var bl=contentInner.querySelector('[data-idx="'+ci+'"]');if(bl){contentEl.scrollTop=getContentOffset(bl)+cp2*bl.offsetHeight;if(ci!==S.currentChapter){S.currentChapter=ci;highlightToc();updateBmBtn()}}else{goToChapter(ci,function(){var b2=contentInner.querySelector('[data-idx="'+ci+'"]');if(b2)contentEl.scrollTop=getContentOffset(b2)+cp2*b2.offsetHeight})}}
function setupProgressDrag(){var dragging=false;function getPct(e){var r=progressTrack.getBoundingClientRect();var cx=e.touches?e.touches[0].clientX:e.clientX;return Math.max(0,Math.min(1,(cx-r.left)/r.width))}function visual(p){var pd=getProgressData(),pi=Math.round(p*100);progressFill.style.width=pi+'%';progressThumb.style.left=pi+'%';var tc=p*pd.total,ci=0;for(var i=0;i<pd.cum.length-1;i++){if(pd.cum[i+1]>=tc){ci=i;break}ci=i+1}ci=Math.min(ci,S.chapters.length-1);progressTip.textContent=(S.chapters[ci]?S.chapters[ci].title:'')+' · '+pi+'%';positionProgressTip(pi)}function start(e){if(!S.chapters.length)return;dragging=true;progressTrack.classList.add('active');visual(getPct(e))}function move(e){if(!dragging)return;visual(getPct(e));e.preventDefault()}function end(e){if(!dragging)return;dragging=false;progressTrack.classList.remove('active');var r=progressTrack.getBoundingClientRect();var cx=e.changedTouches?e.changedTouches[0].clientX:e.clientX;jumpToPercent(Math.max(0,Math.min(1,(cx-r.left)/r.width)))}on(progressTrack,'mousedown',start);on(document,'mousemove',move);on(document,'mouseup',end);on(progressTrack,'touchstart',function(e){e.preventDefault();start(e)},{passive:false});on(document,'touchmove',move,{passive:false});on(document,'touchend',end)}

/* ===== 替换规则 ===== */
function getRepRules(){
  if(!S.fileName)return[];
  if(_repList===null){try{_repList=JSON.parse(localStorage.getItem('jd_rep_'+S.fileName))||[]}catch(e){_repList=[]}}
  return _repList;
}
function saveRepRules(l){_repList=l;if(!S.fileName)return;try{localStorage.setItem('jd_rep_'+S.fileName,JSON.stringify(l))}catch(e){}}
function repAnyOn(){var r=getRepRules();for(var i=0;i<r.length;i++){if(r[i].on&&r[i].f)return true}return false}
function updateRepSwitch(){var sw=$('switch-rep');if(sw)sw.checked=repAnyOn()}

/* ===== 高亮词 ===== */
function getHlList(){
  if(!S.fileName)return[];
  if(_hlList===null){try{_hlList=JSON.parse(localStorage.getItem('jd_hl_'+S.fileName))||[]}catch(e){_hlList=[]}}
  return _hlList;
}
function saveHlList(l){_hlList=l;if(!S.fileName)return;try{localStorage.setItem('jd_hl_'+S.fileName,JSON.stringify(l))}catch(e){}}
function hlColorMap(){
  var map={};
  var ws=getHlList();
  if(!ws.length)return map;
  /* 长词优先：短到长插入，同词后插覆盖（靠后的长词优先取色） */
  var sorted=ws.slice().filter(function(x){return x.w&&x.w.trim()}).sort(function(a,b){return a.w.length-b.w.length});
  for(var i=0;i<sorted.length;i++){if(!map[sorted[i].w])map[sorted[i].w]=sorted[i].c||POMO_COLORS[0]}
  return map;
}
function buildHlRegex(map){
  var words=Object.keys(map);
  if(!words.length)return null;
  var escR=function(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')};
  return new RegExp(words.map(escR).join('|'),'g');
}

/* ===== 渲染装饰管道：替换规则 + 高亮词（一遍 TreeWalker，替换后的文本参与高亮匹配） ===== */
function applyTextDecor(root){
  var rules=getRepRules().filter(function(r){return r.on&&r.f});
  var map=hlColorMap();
  var rg=buildHlRegex(map);
  if(!rules.length&&!rg)return;
  var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),ns=[];
  while(w.nextNode())ns.push(w.currentNode);
  for(var i=0;i<ns.length;i++){
    var nd=ns[i],v=nd.nodeValue;
    if(!v)continue;
    if(rules.length){
      for(var j=0;j<rules.length;j++)v=v.split(rules[j].f).join(rules[j].t);
    }
    if(rg&&v){
      rg.lastIndex=0;
      if(rg.test(v)){
        rg.lastIndex=0;
        var frag=document.createDocumentFragment(),la=0,m;
        while((m=rg.exec(v))!==null){
          var w0=m[0];
          frag.appendChild(document.createTextNode(v.slice(la,m.index)));
          var sp=document.createElement('span');sp.className='hlw';sp.style.color=map[w0];sp.textContent=w0;
          frag.appendChild(sp);
          la=m.index+w0.length;
        }
        frag.appendChild(document.createTextNode(v.slice(la)));
        nd.parentNode.replaceChild(frag,nd);
        continue;
      }
    }
    if(v!==nd.nodeValue)nd.nodeValue=v;
  }
}

/* ===== 划线笔记 ===== */
function getAnnotations(){try{return JSON.parse(localStorage.getItem('jd_ant_'+S.fileName))||[]}catch(e){return[]}}
function saveAnnotations(list){try{localStorage.setItem('jd_ant_'+S.fileName,JSON.stringify(list))}catch(e){}}
/* 渲染恢复：按最终渲染文本（textContent 顺序）累积偏移，与划线区间求交后包裹 span */
function applyAnnotations(root,chIdx){
  var all=getAnnotations();
  if(!all.length)return;
  var ants=[],i;
  for(i=0;i<all.length;i++){if(all[i].ch===chIdx){var a=all[i];a._i=i;ants.push(a)}}
  if(!ants.length)return;

  var fullText=root.textContent||'';
  var rules=getRepRules().filter(function(r){return r.on&&r.f});
  var applyRulesToText=function(str){
    if(!rules.length||!str)return str;
    for(var ri=0;ri<rules.length;ri++)str=str.split(rules[ri].f).join(rules[ri].t);
    return str;
  };
  var findClosestIndex=function(str,pattern,pivot){
    if(!pattern||!str)return -1;
    var best=-1,minDist=Infinity,idx=str.indexOf(pattern);
    while(idx!==-1){
      var dist=Math.abs(idx-pivot);
      if(dist<minDist){minDist=dist;best=idx}
      idx=str.indexOf(pattern,idx+1);
    }
    return best;
  };

  /* 纠偏：针对每个划线计算在当前渲染文本下的有效真实区间 _effStart / _effEnd */
  for(i=0;i<ants.length;i++){
    var an=ants[i];
    var target=an.txt||an.snip||'';
    var effStart=an.start,effEnd=an.end;

    if(target&&fullText){
      var curSlice=fullText.slice(an.start,an.start+target.length);
      if(curSlice===target){
        // 无偏移，当前位置与原划线文本完全吻合
      }else{
        // 尝试就近查找目标文本
        var foundIdx=findClosestIndex(fullText,target,an.start);
        if(foundIdx!==-1&&Math.abs(foundIdx-an.start)<3000){
          effStart=foundIdx;
          effEnd=foundIdx+target.length;
        }else if(rules.length){
          // 若目标文本本身含有被替换词，用规则转换后再就近查找
          var repTarget=applyRulesToText(target);
          var repIdx=findClosestIndex(fullText,repTarget,an.start);
          if(repIdx!==-1&&Math.abs(repIdx-an.start)<3000){
            effStart=repIdx;
            effEnd=repIdx+repTarget.length;
          }
        }
      }
    }
    an._effStart=effStart;
    an._effEnd=effEnd;
  }

  ants.sort(function(x,y){return x._effStart-y._effStart});

  var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),ns=[],acc=0;
  while(w.nextNode()){
    var n=w.currentNode,len=n.nodeValue.length;
    ns.push({n:n,s:acc,e:acc+len});
    acc+=len;
  }
  for(i=0;i<ants.length;i++){
    var an2=ants[i];
    for(var j=0;j<ns.length;j++){
      var seg=ns[j];
      if(seg.e<=an2._effStart||seg.s>=an2._effEnd)continue;
      var from=Math.max(seg.s,an2._effStart)-seg.s;
      var to=Math.min(seg.e,an2._effEnd)-seg.s;
      _wrapAnt(seg.n,from,to,an2);
    }
  }
}
function _wrapAnt(node,from,to,a){
  var span=document.createElement('span');
  span.className='ant';
  span.style.background=a.c;
  span.dataset.i=a._i;
  span.dataset.s=a._effStart!==undefined?a._effStart:a.start;
  var frag=document.createDocumentFragment();
  if(from>0)frag.appendChild(document.createTextNode(node.nodeValue.slice(0,from)));
  span.appendChild(document.createTextNode(node.nodeValue.slice(from,to)));
  frag.appendChild(span);
  if(to<node.nodeValue.length)frag.appendChild(document.createTextNode(node.nodeValue.slice(to)));
  node.parentNode.replaceChild(frag,node);
}
/* 由 Range.toString() 计算节点内某点相对 body 的字符偏移 */
function _ptAbs(body,node,off){
  try{
    var r=document.createRange();
    r.setStart(body,0);
    r.setEnd(node,off);
    return r.toString().length;
  }catch(e){return -1}
}
function getSelAntRange(){
  var sel=window.getSelection();
  if(!sel||sel.isCollapsed||!sel.rangeCount)return null;
  var r=sel.getRangeAt(0);
  if(r.collapsed)return null;
  var anc=sel.anchorNode,foc=sel.focusNode;
  if(!anc||!foc)return null;
  var aEl=anc.nodeType===1?anc:anc.parentElement;
  var fEl=foc.nodeType===1?foc:foc.parentElement;
  var blkA=aEl?aEl.closest('.ch-block'):null;
  var blkF=fEl?fEl.closest('.ch-block'):null;
  if(!blkA&&!blkF)return null;
  if(blkA&&blkF&&blkA!==blkF)return null;
  var blk=blkA||blkF;
  var body=blk.querySelector('.ch-body');
  if(!body)return null;
  var start=_ptAbs(body,anc,sel.anchorOffset);
  var end=_ptAbs(body,foc,sel.focusOffset);
  if(start<0||end<0)return null;
  if(start===end)return null;
  if(start>end){var t=start;start=end;end=t}
  var total=body.textContent.length;
  end=Math.min(end,total);start=Math.min(start,total);
  if(end-start<1)return null;
  return{ch:+blk.dataset.idx,start:start,end:end,body:body};
}
function _hasOverlap(ants,ch,start,end){
  for(var i=0;i<ants.length;i++){
    var a=ants[i];
    if(a.ch!==ch)continue;
    if(a.start<end&&a.end>start)return true;
  }
  return false;
}
function textFromRange(body,start,end){
  var w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),acc=0,out='';
  while(w.nextNode()){
    var n=w.currentNode,len=n.nodeValue.length;
    if(acc+len<=start){acc+=len;continue}
    if(acc>=end)break;
    var from=Math.max(acc,start)-acc,to=Math.min(acc+len,end)-acc;
    out+=n.nodeValue.slice(from,to);
    acc+=len;
  }
  return out;
}
function createAnt(color){
  var range=_selCache;
  if(!range){hideSelToolbar();return}
  var ants=getAnnotations();
  if(_hasOverlap(ants,range.ch,range.start,range.end)){
    hideSelToolbar();clearSelection();_selCache=null;
    toast('该区域已有划线');return;
  }
  var selTxt=textFromRange(range.body,range.start,range.end);
  ants.push({ch:range.ch,start:range.start,end:range.end,c:color,note:'',snip:selTxt.slice(0,60),txt:selTxt,ts:Date.now()});
  saveAnnotations(ants);
  hideSelToolbar();clearSelection();_selCache=null;
  /* 局部重建当前章节显示划线，避免整页刷新 */
  if(reader.classList.contains('active'))rerenderChapterBlock(range.ch);
  renderAnnotations();
  toast('已添加划线');
  triggerImmediateSync();
}
function clearSelection(){try{window.getSelection().removeAllRanges()}catch(e){}}

/* ===== 划线与译文笔记 ===== */
function createAntWithNote(color,noteText){
  var range=_selCache;
  if(!range){hideSelToolbar();return}
  var ants=getAnnotations();
  var overlapIdx=-1;
  for(var i=0;i<ants.length;i++){
    if(ants[i].ch===range.ch&&ants[i].start<range.end&&ants[i].end>range.start){
      overlapIdx=i;break;
    }
  }
  if(overlapIdx>=0){
    ants[overlapIdx].note=(ants[overlapIdx].note?(ants[overlapIdx].note+'\n'):'')+noteText;
    ants[overlapIdx].u=Date.now();
    saveAnnotations(ants);
    if(reader.classList.contains('active'))rerenderChapterBlock(range.ch);
    renderAnnotations();
    hideSelToolbar();clearSelection();_selCache=null;
    toast('已在划线上追加译文笔记');
    triggerImmediateSync();
    return;
  }
  var selTxt=textFromRange(range.body,range.start,range.end);
  ants.push({
    ch:range.ch,
    start:range.start,
    end:range.end,
    c:color||(POMO_COLORS&&POMO_COLORS[0])||'#ffd54f',
    note:noteText||'',
    snip:selTxt.slice(0,60),
    txt:selTxt,
    ts:Date.now()
  });
  saveAnnotations(ants);
  hideSelToolbar();clearSelection();_selCache=null;
  if(reader.classList.contains('active'))rerenderChapterBlock(range.ch);
  renderAnnotations();
  toast('已添加划线并保存译文笔记');
  triggerImmediateSync();
}

/* ===== 划词翻译核心服务（零 Key、双引擎、本地 LRU 缓存） ===== */
var _transQuerySeq=0;
function initTransCache(){
  if(_transCache)return;
  try{_transCache=JSON.parse(localStorage.getItem('jd_trans_cache')||'{}')}catch(e){_transCache={}}
}
function getTransCache(q){
  initTransCache();
  var k=q.trim().toLowerCase();
  return _transCache[k]||null;
}
function setTransCache(q,res){
  initTransCache();
  var k=q.trim().toLowerCase();
  _transCache[k]=Object.assign({},res,{ts:Date.now()});
  var keys=Object.keys(_transCache);
  if(keys.length>220){
    keys.sort(function(a,b){return (_transCache[a].ts||0)-(_transCache[b].ts||0)});
    for(var i=0;i<keys.length-200;i++)delete _transCache[keys[i]];
  }
  try{localStorage.setItem('jd_trans_cache',JSON.stringify(_transCache))}catch(e){}
}
function jsonp(url,cbParam,timeoutMs){
  return new Promise(function(resolve,reject){
    var cbName='_yd_cb_'+Date.now()+'_'+Math.floor(Math.random()*10000);
    var script=document.createElement('script');
    var timer=setTimeout(function(){cleanup();reject(new Error('请求超时'))},timeoutMs||4500);
    function cleanup(){
      clearTimeout(timer);
      if(script.parentNode)script.parentNode.removeChild(script);
      delete window[cbName];
    }
    window[cbName]=function(data){cleanup();resolve(data)};
    script.onerror=function(){cleanup();reject(new Error('网络连接异常'))};
    script.src=url+(url.indexOf('?')>=0?'&':'?')+(cbParam||'callback')+'='+cbName;
    document.head.appendChild(script);
  });
}
function fetchTransGoogle(text,targetLang){
  var ctrl=typeof AbortController!=='undefined'?new AbortController():null;
  var tid=ctrl?setTimeout(function(){ctrl.abort()},4500):null;
  var url='https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl='
    +encodeURIComponent(targetLang)+'&q='+encodeURIComponent(text);
  return fetch(url,ctrl?{signal:ctrl.signal}:{}).then(function(r){
    if(tid)clearTimeout(tid);
    if(!r.ok)throw new Error('HTTP '+r.status);
    return r.json();
  }).then(function(data){
    if(Array.isArray(data)&&data[0]&&data[0][0]){
      return {text:data[0][0],from:data[0][1]||'auto',to:targetLang,src:'Google'};
    }
    throw new Error('未能解析翻译结果');
  });
}
function fetchTransYoudao(text){
  var url='https://dict.youdao.com/suggest?num=2&doctype=json&q='+encodeURIComponent(text);
  return jsonp(url,'callback',4500).then(function(data){
    if(data&&data.result&&data.result.code===200&&data.data&&data.data.entries&&data.data.entries.length){
      var e=data.data.entries[0];
      return {text:e.explain||e.entry,from:data.data.language||'en',to:'zh',src:'有道词典',entry:e.entry};
    }
    throw new Error('未在词典中查到释义');
  });
}
function queryTranslation(text,forceEngine){
  var q=text.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g,'$1$2').replace(/\s+/g,' ').trim();
  if(!q)return Promise.reject(new Error('内容为空'));
  var cached=getTransCache(q);
  if(cached)return Promise.resolve(Object.assign({},cached,{fromCache:true}));
  var isZh=/[\u4e00-\u9fa5]/.test(q);
  var targetLang=isZh?'en':'zh-CN';
  var eng=forceEngine||S.transEngine||'auto';

  if(eng==='google'){
    return fetchTransGoogle(q,targetLang).then(function(res){
      setTransCache(q,res);
      return res;
    });
  }
  if(eng==='youdao'){
    return fetchTransYoudao(q).then(function(res){
      setTransCache(q,res);
      return res;
    });
  }
  /* 智能双引擎：优先 Google，短词在 Google 失败时平滑兜底有道词典 */
  return fetchTransGoogle(q,targetLang).catch(function(err){
    if(q.length<=60&&!/[\r\n]/.test(q)){
      return fetchTransYoudao(q);
    }
    throw err;
  }).then(function(res){
    setTransCache(q,res);
    return res;
  });
}
function playTTS(text,lang){
  if(!('speechSynthesis' in window)){toast('浏览器不支持语音朗读');return}
  try{
    window.speechSynthesis.cancel();
    var u=new SpeechSynthesisUtterance(text);
    if(lang==='zh'||lang==='zh-CN'||/[\u4e00-\u9fa5]/.test(text)){
      u.lang='zh-CN';
    }else{
      u.lang='en-US';
    }
    u.rate=1.0;
    window.speechSynthesis.speak(u);
  }catch(e){toast('语音朗读失败')}
}
function isTransActive(){
  try{
    var v=sessionStorage.getItem('jd_trans_active');
    if(v!==null)return v==='1';
  }catch(e){}
  return _transSessionActive;
}
function setTransActive(on){
  _transSessionActive=!!on;
  try{
    sessionStorage.setItem('jd_trans_active',on?'1':'0');
  }catch(e){}
  S.transEnabled=!!on;
  updateTransUI();
}
function updateTransUI(){
  var on=isTransActive();
  var sw=$('switch-trans');if(sw)sw.checked=on;
  var btn=$('st-trans-btn');
  if(btn){
    btn.classList.toggle('active',on);
    btn.setAttribute('title',on?'划词翻译已开启（点击关闭）':'开启划词翻译');
  }
}
function repositionSelToolbar(selR){
  if(!_selToolbar||!_selToolbar.classList.contains('show'))return;
  if(!selR){
    try{
      var sel=window.getSelection();
      if(sel&&sel.rangeCount)selR=sel.getRangeAt(0).getBoundingClientRect();
    }catch(e){}
  }
  if(!selR)return;
  var tw=_selToolbar.offsetWidth,th=_selToolbar.offsetHeight;
  var x=selR.left+(selR.width-tw)/2;
  x=Math.max(8,Math.min(window.innerWidth-tw-8,x));
  var y=selR.top-th-10;
  if(y<8)y=selR.bottom+10;
  y=Math.max(8,Math.min(window.innerHeight-th-8,y));
  _selToolbar.style.left=x+'px';
  _selToolbar.style.top=y+'px';
}
function triggerTrans(force){
  var range=_selCache;
  if(!range)return;
  var selTxt=textFromRange(range.body,range.start,range.end).trim();
  if(!selTxt)return;
  _lastTransText=selTxt;
  var origEl=$('st-trans-orig'),bodyEl=$('st-trans-body'),tagEl=$('st-trans-tag');
  if(origEl)origEl.textContent=selTxt;
  if(tagEl)tagEl.textContent='翻译';
  if(bodyEl)bodyEl.innerHTML='<div class="st-trans-loading">正在翻译...</div>';
  repositionSelToolbar();

  var curSeq=++_transQuerySeq;
  queryTranslation(selTxt,force?S.transEngine:null).then(function(res){
    if(curSeq!==_transQuerySeq)return;
    _lastTransResult=res;
    var label=(res.fromCache?'缓存 · ':'')+(res.src||'');
    if(tagEl)tagEl.textContent=label||'翻译';
    if(bodyEl)bodyEl.textContent=res.text;
    repositionSelToolbar();
  }).catch(function(err){
    if(curSeq!==_transQuerySeq)return;
    _lastTransResult=null;
    if(bodyEl){
      bodyEl.innerHTML='<div class="st-trans-error" id="st-trans-retry">翻译失败，点击重试 ('+esc(err.message||'网络异常')+')</div>';
    }
    repositionSelToolbar();
  });
}

/* ===== 选区浮动工具条 ===== */
function initSelToolbar(){
  _selToolbar=$('sel-toolbar');
  _stColors=$('st-colors');
  if(!_selToolbar||!_stColors)return;
  _stColors.innerHTML=POMO_COLORS.map(function(c){
    return '<button type="button" class="st-color" data-c="'+c+'" title="划线" aria-label="划线" style="background:'+c+'"></button>';
  }).join('');
  on(_selToolbar,'mousedown',function(e){
    if(!e.target.closest('.st-trans-body'))e.preventDefault();
  });
  on(_stColors,'click',function(e){
    var b=e.target.closest('.st-color');
    if(b)createAnt(b.dataset.c);
  });
  on($('st-trans-btn'),'click',function(){
    var nowActive=!isTransActive();
    setTransActive(nowActive);
    if(nowActive){
      _selToolbar.classList.add('show-trans');
      triggerTrans();
      repositionSelToolbar();
      toast('已开启划词翻译（当前会话有效）');
    }else{
      _selToolbar.classList.remove('show-trans');
      repositionSelToolbar();
      toast('已关闭划词翻译');
    }
  });
  on($('st-trans-tts'),'click',function(){
    if(_lastTransText)playTTS(_lastTransText,_lastTransResult?_lastTransResult.from:'');
  });
  on($('st-trans-copy'),'click',function(){
    if(_lastTransResult&&_lastTransResult.text){
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(_lastTransResult.text).then(function(){
          toast('已复制译文');
        }).catch(function(){toast('复制失败')});
      }else{toast('复制功能暂不可用')}
    }
  });
  on($('st-trans-note'),'click',function(){
    if(_lastTransResult&&_lastTransResult.text){
      createAntWithNote(POMO_COLORS[0],'译文：'+_lastTransResult.text);
    }
  });
  on($('st-trans-body'),'click',function(e){
    if(e.target.closest('#st-trans-retry')){
      triggerTrans(true);
    }
  });
  on($('st-close'),'click',function(){hideSelToolbar();clearSelection();_selCache=null});
  updateTransUI();
}
function showSelToolbar(){
  var range=getSelAntRange();
  if(!range||!_selToolbar)return;
  _selCache=range;
  var selR=window.getSelection().getRangeAt(0).getBoundingClientRect();
  _selToolbar.classList.add('show');

  var selTxt=textFromRange(range.body,range.start,range.end).trim();
  _lastTransResult=null;_lastTransText=selTxt;
  var active=isTransActive()&&selTxt.length<=300;

  updateTransUI();

  if(active){
    _selToolbar.classList.add('show-trans');
    triggerTrans();
  }else{
    _selToolbar.classList.remove('show-trans');
  }
  repositionSelToolbar(selR);
}
function hideSelToolbar(){
  if(_selToolbar){
    _selToolbar.classList.remove('show');
    _selToolbar.classList.remove('show-trans');
    updateTransUI();
  }
}

/* ===== 划线操作弹窗 ===== */
function initAntPop(){
  _antPop=$('ant-pop');
  if(!_antPop)return;
  on($('ant-pop-close'),'click',hideAntPop);
  on($('ant-pop-del'),'click',deleteAntFromPop);
  on($('ant-pop-save'),'click',saveAntNoteFromPop);
}
function showAntPop(span){
  var idx=+span.dataset.i;
  var ants=getAnnotations();
  var a=ants[idx];
  if(!a)return;
  _antPopIdx=idx;
  var note=$('ant-note');
  note.value=a.note||'';
  _antPop.classList.add('show');
  var r=span.getBoundingClientRect();
  var w=_antPop.offsetWidth,h=_antPop.offsetHeight;
  var x=r.left+(r.width-w)/2;
  x=Math.max(8,Math.min(window.innerWidth-w-8,x));
  var y=r.bottom+8;
  if(y+h>window.innerHeight-8)y=r.top-h-8;
  _antPop.style.left=x+'px';
  _antPop.style.top=y+'px';
}
function hideAntPop(){if(_antPop){_antPop.classList.remove('show');_antPopIdx=-1}}
function saveAntNoteFromPop(){
  if(_antPopIdx<0)return;
  var ants=getAnnotations();
  var a=ants[_antPopIdx];
  if(!a){hideAntPop();return}
  a.note=$('ant-note').value.trim();
  a.u=Date.now();
  saveAnnotations(ants);
  renderAnnotations();
  hideAntPop();
  toast('备注已保存');
  triggerImmediateSync();
}
function deleteAntFromPop(){
  if(_antPopIdx<0)return;
  var ants=getAnnotations();
  var a=ants[_antPopIdx];
  if(a&&S.fileName){
    var delAnts=[];
    try{delAnts=JSON.parse(localStorage.getItem('jd_del_ant_'+S.fileName)||'[]')}catch(e){}
    delAnts.push({sig:getAntSig(a),ts:Date.now()});
    try{localStorage.setItem('jd_del_ant_'+S.fileName,JSON.stringify(delAnts.slice(-50)))}catch(e){}
  }
  ants.splice(_antPopIdx,1);
  saveAnnotations(ants);
  hideAntPop();
  /* 局部重建当前章节移除划线 */
  if(reader.classList.contains('active'))rerenderChapterBlock(S.currentChapter);
  renderAnnotations();
  toast('已删除划线');
  triggerImmediateSync();
}

/* ===== 侧栏笔记列表 ===== */
function renderAnnotations(){
  var list=$('ant-list');
  if(!list)return;
  var ants=getAnnotations();
  if(!ants.length){
    list.innerHTML='<div class="ant-empty">暂无划线笔记<br><small>阅读时选中文本即可划线</small></div>';
    return;
  }
  var idxs=[];
  ants.forEach(function(a,i){idxs.push(i)});
  idxs.sort(function(a,b){return ants[b].ts-ants[a].ts});
  list.innerHTML=idxs.map(function(i){
    var a=ants[i];
    var cn=S.chapters[a.ch]?S.chapters[a.ch].title:'未知章节';
    var dt=new Date(a.ts);
    var ds=(dt.getMonth()+1)+'/'+dt.getDate()+' '+dt.getHours()+':'+String(dt.getMinutes()).padStart(2,'0');
    var note=a.note?'<div class="ant-note-preview">'+esc(a.note)+'</div>':'';
    return '<div class="ant-item">'+
      '<button type="button" class="ant-open" onclick="J.goAnt('+i+')">'+
      '<div class="ant-snippet">'+esc(a.snip||'')+'</div>'+note+
      '<div class="ant-meta"><span>'+cn+'</span><span>'+ds+'</span></div></button>'+
      '<button type="button" class="ant-del" onclick="J.delAnt('+i+')" title="删除" aria-label="删除划线"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'+
      '</div>';
  }).join('');
}

/* ===== 设置面板：替换规则 / 高亮词 / 分类列表 ===== */
function renderRepList(){
  var el=$('rep-list');if(!el)return;
  var rules=getRepRules();
  el.innerHTML=rules.length?rules.map(function(r,i){
    return '<div class="rep-item'+(r.on?'':' rep-off')+'">'+
      '<button type="button" class="rep-toggle'+(r.on?' on':'')+'" data-i="'+i+'" aria-label="开关"></button>'+
      '<span class="rep-f">'+esc(r.f)+'</span><span class="rep-arrow">→</span><span class="rep-t">'+esc(r.t||'')+'</span>'+
      '<button type="button" class="rep-del" data-i="'+i+'" title="删除" aria-label="删除规则"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'+
      '</div>';
  }).join(''):'<div class="rep-empty">暂无替换规则</div>';
}
function renderHlList(){
  var el=$('hl-list');if(!el)return;
  var ws=getHlList();
  el.innerHTML=ws.length?ws.map(function(x,i){
    return '<div class="hl-item"><span class="hl-swatch" style="background:'+x.c+'"></span><span class="hl-word">'+esc(x.w)+'</span>'+
      '<button type="button" class="hl-del" data-i="'+i+'" title="删除" aria-label="删除高亮词"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>';
  }).join(''):'<div class="hl-empty">暂无高亮词</div>';
}
function initHlColors(){
  var el=$('hl-colors');if(!el||el.dataset.init)return;
  el.dataset.init='1';
  el.innerHTML=POMO_COLORS.map(function(c,i){
    return '<button type="button" class="hl-color'+(i===0?' sel':'')+'" data-c="'+c+'" title="颜色" aria-label="颜色" style="background:'+c+'"></button>';
  }).join('');
  on(el,'click',function(e){
    var b=e.target.closest('.hl-color');
    if(!b)return;
    el.querySelectorAll('.hl-color').forEach(function(x){x.classList.remove('sel')});
    b.classList.add('sel');
  });
}
function selHlColor(){
  var el=$('hl-colors');
  var b=el?el.querySelector('.hl-color.sel'):null;
  return b?b.dataset.c:POMO_COLORS[0];
}
/* 修改了替换/高亮词后重建所有已渲染章节 */
function rerenderCurrent(){
  if(reader.classList.contains('active')&&S.chapters.length)rerenderAllBlocks();
}

/* ===== 番茄钟 ===== */
function initPomo(){
  updatePomoBtn();
  on($('btn-pomo'),'click',togglePomo);
}
function togglePomo(){
  if(_pomo){stopPomo();return}
  var min=S.pomoMin||25;
  _pomo={end:Date.now()+min*60000};
  updatePomoBtn();
  _pomoTimer=setInterval(updatePomoBtn,1000);
  toast('番茄钟开始：'+min+' 分钟');
}
function stopPomo(){
  if(_pomoTimer){clearInterval(_pomoTimer);_pomoTimer=null}
  _pomo=null;
  updatePomoBtn();
  toast('番茄钟已停止');
}
function updatePomoBtn(){
  var btn=$('btn-pomo');if(!btn)return;
  if(!_pomo){
    btn.classList.remove('running','pulse');
    btn.innerHTML=POMO_ICON;
    return;
  }
  var rem=_pomo.end-Date.now();
  if(rem<=0){finishPomo();return}
  var m=Math.floor(rem/60000),s=Math.floor(rem%60000/1000);
  btn.classList.add('running');
  btn.textContent=String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}
function finishPomo(){
  if(_pomoTimer){clearInterval(_pomoTimer);_pomoTimer=null}
  _pomo=null;
  updatePomoBtn();
  toast('番茄钟结束，休息一下吧');
  if('Notification' in window&&Notification.permission==='granted'){
    try{new Notification('简读 · 番茄钟',{body:'阅读了一节，休息一下吧'})}catch(e){}
  }
}

/* ===== 粘性章节标题 ===== */
function updateStickyHead(){
  var sh=$('sticky-head');if(!sh)return;
  var ch=S.chapters[S.currentChapter];
  sh.textContent=ch?(ch.title||''):'';
}

/* ===== 书籍标签 ===== */
/* jd_cats 存储对象数组 [{n:名称, c:颜色}]；兼容旧版字符串数组，读取时自动迁移 */
function getCats(){
  try{
    var d=JSON.parse(localStorage.getItem('jd_cats'))||[];
    if(!Array.isArray(d))d=[];
    var migrated=false,out=[];
    for(var i=0;i<d.length;i++){
      var x=d[i];
      if(typeof x==='string'){out.push({n:x,c:POMO_COLORS[i%POMO_COLORS.length]});migrated=true;continue}
      if(x&&typeof x.n==='string'){
        if(typeof x.c==='string'&&x.c){out.push({n:x.n,c:x.c})}
        else{out.push({n:x.n,c:POMO_COLORS[i%POMO_COLORS.length]});migrated=true}
        continue;
      }
      migrated=true;
    }
    if(migrated)saveCats(out);
    return out;
  }catch(e){return[]}
}
function saveCats(c){try{localStorage.setItem('jd_cats',JSON.stringify(c))}catch(e){}}
function catColor(name){
  var cats=getCats();
  for(var i=0;i<cats.length;i++){if(cats[i].n===name)return cats[i].c||''}
  return '';
}
function libCatCount(c){var l=getLib(),n=0;for(var i=0;i<l.length;i++){if((l[i].cat||'')===c)n++}return n}
function renderCatList(){
  var el=$('cat-list');if(!el)return;
  var cats=getCats();
  el.innerHTML=cats.length?cats.map(function(c,i){
    var cc=c.c||'';
    return '<div class="cat-item">'+
      '<button type="button" class="cat-swatch" data-i="'+i+'" style="background:'+(cc||'#ccc')+'" title="点击设置颜色" aria-label="设置标签颜色"></button>'+
      '<span class="cat-name" data-i="'+i+'" title="点击重命名">'+esc(c.n)+'</span>'+
      '<span class="cat-count">'+libCatCount(c.n)+' 本</span>'+
      '<button type="button" class="cat-del" data-i="'+i+'" title="删除标签" aria-label="删除标签"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'+
      '<div class="cat-colors" data-i="'+i+'">'+POMO_COLORS.map(function(col){return'<button type="button" class="cat-color'+(col===cc?' sel':'')+'" data-i="'+i+'" data-c="'+col+'" style="background:'+col+'" aria-label="选择颜色"></button>'}).join('')+'</div>'+
      '</div>';
  }).join(''):'<div class="cat-empty">暂无标签，输入名称添加</div>';
}
function openCatPop(name,ev){
  _catTarget=name;
  _catPop=$('cat-pop');_catPopList=$('cat-pop-list');
  if(!_catPop||!_catPopList)return;
  var cur='',lib=getLib();
  for(var i=0;i<lib.length;i++){if(lib[i].n===name){cur=lib[i].cat||'';break}}
  _catPopList.innerHTML='<button type="button" class="cat-pop-item'+(cur===''?' sel':'')+'" data-cat="">未分类</button>'+
    getCats().map(function(c){return'<button type="button" class="cat-pop-item'+(cur===c.n?' sel':'')+'" data-cat="'+esc(c.n)+'">'+(c.c?'<span class="cat-dot" style="background:'+c.c+'"></span>':'')+'<span>'+esc(c.n)+'</span></button>'}).join('');
  var r=ev.target.closest('.bs-card-cat').getBoundingClientRect();
  var w=_catPop.offsetWidth||170;
  var x=Math.max(8,Math.min(r.left,window.innerWidth-w-8));
  _catPop.style.left=x+'px';
  _catPop.style.top=(r.bottom+6)+'px';
  _catPop.classList.add('show');
}
function closeCatPop(){if(_catPop)_catPop.classList.remove('show');_catTarget=null}
function setBookCat(c){
  if(!_catTarget)return;
  var lib=getLib();
  for(var i=0;i<lib.length;i++){
    if(lib[i].n===_catTarget){lib[i].cat=c||'';break}
  }
  saveLib(lib);
  closeCatPop();
  renderBookshelf();
  toast(c?'已设为「'+c+'」标签':'已取消标签');
}

/* ===== Bookmarks ===== */
function getBookmarks(){try{return JSON.parse(localStorage.getItem('jd_bm_'+S.fileName))||[]}catch(e){return[]}}
function saveBookmarks(bms){try{localStorage.setItem('jd_bm_'+S.fileName,JSON.stringify(bms))}catch(e){}}
function getFirstVisibleLine(){var els=contentInner.querySelectorAll('p, h2, h3, h4, li, blockquote, pre');var rect=contentEl.getBoundingClientRect();var vt=rect.top,vb=rect.bottom;var checked=0;for(var i=0;i<els.length;i++){var r=els[i].getBoundingClientRect();if(r.bottom<=vt||r.top>=vb)continue;checked++;if(checked>10)break;var text=els[i].textContent.trim();if(text)return text.slice(0,SNIP_MAX)}return''}
function toggleBookmark(){
  if(!S.fileName)return;
  var bms=getBookmarks();
  var exist=-1;
  for(var i=0;i<bms.length;i++){
    if(bms[i].ch===S.currentChapter&&Math.abs(bms[i].offset-getChapterOffset())<BM_OFFSET_TOL){
      exist=i;break;
    }
  }
  if(exist>=0){
    var b=bms[exist];
    if(b&&S.fileName){
      var delBms=[];
      try{delBms=JSON.parse(localStorage.getItem('jd_del_bm_'+S.fileName)||'[]')}catch(e){}
      delBms.push({sig:getBmSig(b),ts:Date.now()});
      try{localStorage.setItem('jd_del_bm_'+S.fileName,JSON.stringify(delBms.slice(-50)))}catch(e){}
    }
    bms.splice(exist,1);
    toast('已移除书签');
  }else{
    var firstLine=getFirstVisibleLine();
    if(!firstLine){toast('书签保存失败');return}
    var pct=Math.round(getAccurateProgress()*100);
    bms.push({ch:S.currentChapter,offset:getChapterOffset(),snip:firstLine,progress:pct,ts:Date.now()});
    toast('已添加书签');
  }
  saveBookmarks(bms);renderBookmarks();updateBmBtn();
  triggerImmediateSync();
}
function getChapterOffset(){var bl=contentInner.querySelector('[data-idx="'+S.currentChapter+'"]');return bl?Math.max(0,contentEl.scrollTop-getContentOffset(bl)):0}
function deleteBookmark(i){
  var bms=getBookmarks();
  var b=bms[i];
  if(b&&S.fileName){
    var delBms=[];
    try{delBms=JSON.parse(localStorage.getItem('jd_del_bm_'+S.fileName)||'[]')}catch(e){}
    delBms.push({sig:getBmSig(b),ts:Date.now()});
    try{localStorage.setItem('jd_del_bm_'+S.fileName,JSON.stringify(delBms.slice(-50)))}catch(e){}
  }
  bms.splice(i,1);saveBookmarks(bms);renderBookmarks();updateBmBtn();toast('已删除书签');
  triggerImmediateSync();
}
function renderBookmarks(){var bms=getBookmarks();if(!bms.length){bmList.innerHTML='<div class="bm-empty">暂无书签<br><small>阅读时点击书签图标添加</small></div>';return}bmList.innerHTML=bms.map(function(b,i){var cn=S.chapters[b.ch]?S.chapters[b.ch].title:'未知章节';var dt=new Date(b.ts);var ds=(dt.getMonth()+1)+'/'+dt.getDate()+' '+dt.getHours()+':'+String(dt.getMinutes()).padStart(2,'0');var prog=b.progress!==undefined?'<span class="bm-prog">'+b.progress+'</span>':'';return '<div class="bm-item"><button type="button" class="bm-open" onclick="J.go('+b.ch+','+b.offset+')"><div class="bm-snippet">'+esc(b.snip||'')+'</div><div class="bm-meta"><span>'+cn+'</span><span>'+ds+'</span>'+prog+'</div></button><button type="button" class="bm-del" onclick="J.delBm('+i+')" title="删除" aria-label="删除书签"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>'}).join('')}
function updateBmBtn(){var bms=getBookmarks();var on2=false;for(var i=0;i<bms.length;i++){if(bms[i].ch===S.currentChapter&&Math.abs(bms[i].offset-getChapterOffset())<BM_OFFSET_TOL){on2=true;break}}var btn=$('btn-bm');if(!btn)return;btn.classList.toggle('on',on2);var svg=btn.querySelector('svg');if(svg)svg.setAttribute('fill',on2?'currentColor':'none')}

/* ===== Search ===== */
var _textCache=null,_textCacheLen=0;
function getChText(ch,idx){
  if(!ch)return'';
  if(ch.text)return ch.text;
  if(ch.content)return ch.content;
  if(ch._text)return ch._text;
  if(ch.html&&ch._loaded!==false){
    if(!_textCache||_textCacheLen!==S.chapters.length){_textCache=new Array(S.chapters.length);_textCacheLen=S.chapters.length}
    if(!_textCache[idx]){
      try{_textCache[idx]=_dp.parseFromString('<div>'+ch.html+'</div>','text/html').body.textContent||''}
      catch(e){_textCache[idx]=''}
    }
    ch._text=_textCache[idx];
    return ch._text;
  }
  return'';
}
function syncSearchBar(){searchBar.style.top=toolbar.classList.contains('visible')?'54px':'0'}
function openSearch(){searchBar.classList.add('open');toolbar.classList.add('visible');progressTrack.classList.add('active');$('btn-search').classList.add('on');syncSearchBar();searchInput.focus();searchInput.select()}
function closeSearch(){
  searchBar.classList.remove('open');$('btn-search').classList.remove('on');
  searchInput.value='';S.searchQuery='';S.searchResults=[];S.searchIdx=-1;
  _searchToken++;
  clearHighlights();updateSearchCount();
}
function doSearch(){
  var q=convText(searchInput.value.trim());
  S.searchQuery=q;
  if(!q){S.searchResults=[];S.searchIdx=-1;clearHighlights();updateSearchCount();return}
  var token=++_searchToken;
  searchCount.textContent='搜索中…';
  if(S.storeMode==='v2'&&S.fileName){
    dbScanSearch(S.fileName,q,token,function(r){
      if(token!==_searchToken)return;
      if(!r)return;
      finishSearch(r);
    });
    return;
  }
  /* 内存分片搜索，避免大书卡死主线程 */
  var r=[],ql=q.toLowerCase(),i=0,n=S.chapters.length,BATCH=30;
  function step(){
    if(token!==_searchToken)return;
    var end=Math.min(i+BATCH,n);
    for(;i<end;i++){
      var t=convText(getChText(S.chapters[i],i));
      if(!t)continue;
      var tl=t.toLowerCase(),p=0,stepLen=ql.length||1;
      while((p=tl.indexOf(ql,p))!==-1){r.push({ch:i,pos:p});p+=stepLen}
    }
    if(i<n){
      if(typeof requestIdleCallback!=='undefined')requestIdleCallback(step,{timeout:80});
      else setTimeout(step,0);
      return;
    }
    finishSearch(r);
  }
  step();
}
function finishSearch(r){
  S.searchResults=r||[];
  S.searchIdx=S.searchResults.length?0:-1;
  if(S.searchIdx>=0)navigateToResult();
  else{clearHighlights();updateSearchCount()}
}
function navigateToResult(){var r=S.searchResults[S.searchIdx];if(!r)return;var bl=contentInner.querySelector('[data-idx="'+r.ch+'"]');if(bl){applyHighlights();scrollToActive()}else{goToChapter(r.ch,function(){applyHighlights();scrollToActive()})}updateSearchCount()}
function applyHighlights(){clearHighlights();if(!S.searchQuery)return;var q2=S.searchQuery,blocks=contentInner.querySelectorAll('.ch-block');for(var bi=0;bi<blocks.length;bi++){var body=blocks[bi].querySelector('.ch-body');if(!body||body.textContent.toLowerCase().indexOf(q2)===-1)continue;var w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),ns=[];while(w.nextNode())ns.push(w.currentNode);for(var ni=0;ni<ns.length;ni++){var nd=ns[ni],t=nd.textContent,l=t.toLowerCase(),ql=q2.toLowerCase(),p=l.indexOf(ql);if(p===-1)continue;var f=document.createDocumentFragment(),la=0;while(p!==-1){f.appendChild(document.createTextNode(t.slice(la,p)));var m=document.createElement('mark');m.className='shl';m.textContent=t.slice(p,p+q2.length);f.appendChild(m);la=p+q2.length;p=l.indexOf(ql,la)}f.appendChild(document.createTextNode(t.slice(la)));nd.parentNode.replaceChild(f,nd)}}highlightActiveMark()}
function clearHighlights(){contentInner.querySelectorAll('mark.shl').forEach(function(m){var frag=document.createDocumentFragment();while(m.firstChild)frag.appendChild(m.firstChild);m.replaceWith(frag)});contentInner.normalize()}
function highlightActiveMark(){var r=S.searchResults[S.searchIdx];if(!r||r.ch!==S.currentChapter)return;var base=0;for(var i=0;i<r.ch;i++){for(var j=0;j<S.searchResults.length;j++){if(S.searchResults[j].ch===i)base++}}var idx=S.searchIdx-base;var ms=contentInner.querySelectorAll('mark.shl');if(idx>=0&&idx<ms.length){ms.forEach(function(m){m.classList.remove('act')});ms[idx].classList.add('act')}}
function scrollToActive(){var a=contentInner.querySelector('mark.shl.act');if(a)a.scrollIntoView({behavior:'smooth',block:'center'})}
function searchPrev(){if(!S.searchResults.length)return;S.searchIdx=(S.searchIdx-1+S.searchResults.length)%S.searchResults.length;navigateToResult()}
function searchNext(){if(!S.searchResults.length)return;S.searchIdx=(S.searchIdx+1)%S.searchResults.length;navigateToResult()}
function updateSearchCount(){searchCount.textContent=S.searchResults.length?(S.searchIdx+1)+'/'+S.searchResults.length:''}

/* ===== TOC ===== */
/* ===== TOC 虚拟列表 ===== */
function buildTOC(){
  var el=$('sidebar-title');if(el)el.textContent=S.epubTitle||S.fileName.replace(/\.[^.]+$/,'');
  var el2=$('sidebar-info');if(el2)el2.textContent=S.chapters.length+' 章 · '+fmtSize(S.fileSize);
  _tocItems=[];
  if(S.toc&&S.toc.length){
    for(var i=0;i<S.toc.length;i++){
      var t=S.toc[i];
      _tocItems.push({
        kind:'toc',
        tocIdx:i,
        title:t.title||'',
        href:t.href||'',
        level:t.level||0,
        ch:-1,
        hIdx:-1
      });
    }
  }else{
    for(var j=0;j<S.chapters.length;j++){
      _tocItems.push({kind:'ch',tocIdx:-1,title:S.chapters[j].title||('章节 '+(j+1)),href:'',level:0,ch:j,hIdx:-1});
    }
  }
  ensureTocShell();
  renderTocWindow();
  highlightToc();
}
function ensureTocShell(){
  if(!tocList)return;
  if(!tocList.querySelector('.toc-virt')){
    tocList.innerHTML='<div class="toc-virt"><div class="toc-spacer"></div><div class="toc-window"></div></div>';
    if(!_tocScrollBound){
      _tocScrollBound=true;
      on(tocList,'scroll',function(){renderTocWindow()},{passive:true});
      on(tocList,'click',function(e){
        var item=e.target.closest('.toc-item');if(!item)return;
        var vi=+item.dataset.vi;
        var row=_tocItems[vi];if(!row)return;
        if(row.kind==='toc')goToc(row.tocIdx);
        else if(row.kind==='heading')J.goToHeading(row.ch,row.hIdx);
        else if(row.kind==='ch')goToChapter(row.ch);
      });
    }
  }
  var spacer=tocList.querySelector('.toc-spacer');
  if(spacer)spacer.style.height=(_tocItems.length*_tocItemH)+'px';
}
function renderTocWindow(){
  if(!tocList||!_tocItems.length){
    if(tocList)tocList.innerHTML='<div class="toc-empty">暂无目录</div>';
    return;
  }
  ensureTocShell();
  var win=tocList.querySelector('.toc-window');
  var spacer=tocList.querySelector('.toc-spacer');
  if(!win||!spacer)return;
  spacer.style.height=(_tocItems.length*_tocItemH)+'px';
  var st=tocList.scrollTop;
  var vh=tocList.clientHeight||400;
  var start=Math.max(0,Math.floor(st/_tocItemH)-8);
  var end=Math.min(_tocItems.length,Math.ceil((st+vh)/_tocItemH)+8);
  var html=[];
  for(var i=start;i<end;i++){
    var row=_tocItems[i];
    var cls='toc-item';
    if(row.level===1||row.kind==='heading')cls+=' toc-l1';
    if(row.level>=2)cls+=' toc-l2';
    if(row.kind==='ch'&&row.ch===S.currentChapter)cls+=' current';
    if(row.kind==='toc'){
      var chItem=S.chapters[S.currentChapter];
      if(chItem&&row.href&&hrefMatch(row.href,chItem.href||''))cls+=' toc-current';
    }
    html.push('<button type="button" class="'+cls+'" data-vi="'+i+'" style="top:'+(i*_tocItemH)+'px;height:'+_tocItemH+'px">'+esc(row.title||'')+'</button>');
  }
  win.innerHTML=html.join('');
}
function highlightToc(){
  if(!_tocItems.length)return;
  var curIdx=-1;
  if(S.toc&&S.toc.length){
    var chItem=S.chapters[S.currentChapter];
    var chHref=chItem?(chItem.href||''):'';
    if(chHref){
      for(var i=0;i<_tocItems.length;i++){
        if(_tocItems[i].kind==='toc'&&_tocItems[i].href&&hrefMatch(_tocItems[i].href,chHref))curIdx=i;
      }
    }
  }else{
    for(var j=0;j<_tocItems.length;j++){
      if(_tocItems[j].kind==='ch'&&_tocItems[j].ch===S.currentChapter){curIdx=j;break}
    }
  }
  if(curIdx>=0){
    var target=curIdx*_tocItemH;
    var st=tocList.scrollTop,vh=tocList.clientHeight||400;
    if(target<st||target>st+vh-_tocItemH){
      tocList.scrollTop=Math.max(0,target-vh/3);
    }
  }
  renderTocWindow();
}
function goToc(idx){
  if(!S.toc||!S.toc.length)return;
  var item=S.toc[idx];if(!item)return;
  var href=item.href||'';
  var chIdx=findChapterByHref(href);
  /* 禁止用 TOC 序号硬顶 spine 序号：目录常含卷/插图等额外项，越往后偏差越大 */
  if(chIdx<0){
    toast('无法定位该章节');
    return;
  }
  var anchor=href.indexOf('#')>=0?href.split('#')[1]:'';
  goToChapter(chIdx,function(){
    if(!anchor)return;
    var safe=anchor.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
    var el=contentInner.querySelector('[id="'+safe+'"]')||contentInner.querySelector('[name="'+safe+'"]');
    if(el)scrollToElement(el,60);
  });
}

/* ===== Save/Load Progress ===== */
function saveProg(){
  try{
    var a=JSON.parse(localStorage.getItem('jd_p')||'{}');
    var pct=0;try{pct=Math.round(getAccurateProgress()*100)}catch(e){}
    var ch=S.currentChapter,offset=Math.max(0,getChapterOffset());
    a[S.fileName]={ch:ch,offset:offset,pct:pct,ts:Date.now()};
    localStorage.setItem('jd_p',JSON.stringify(a));
  }catch(e){}
}
function loadProg(n){try{return(JSON.parse(localStorage.getItem('jd_p')||'{}'))[n]||null}catch(e){return null}}

/* 移动端旋转会重排章节高度；用文本进度而非旧像素 scrollTop 恢复位置。 */
var _viewportProgress=null,_viewportRestoreTimer=null;
function preserveReaderViewport(){
  if(!reader.classList.contains('active')||!S.chapters.length)return;
  if(_viewportProgress===null){
    updateReadingChapter();
    _viewportProgress=getAccurateProgress();
  }
  if(_viewportRestoreTimer)clearTimeout(_viewportRestoreTimer);
  _viewportRestoreTimer=setTimeout(function(){
    var pct=_viewportProgress;
    _viewportProgress=null;_viewportRestoreTimer=null;
    if(pct===null||!reader.classList.contains('active'))return;
    applySettings();
    requestAnimationFrame(function(){requestAnimationFrame(function(){jumpToPercent(pct);updateProgress();saveProg()})});
  },180);
}

/* ===== Events ===== */
function setupSettingsEvents(){
  on($('range-fs'),'input',function(e){S.fontSize=+e.target.value;applySettings();saveSettings()});
  on($('range-lh'),'input',function(e){S.lineHeight=+e.target.value;applySettings();saveSettings()});
  document.querySelectorAll('[data-pad]').forEach(function(b){on(b,'click',function(){S.padding=b.dataset.pad;applySettings();saveSettings()})});
  document.querySelectorAll('[data-color]').forEach(function(b){on(b,'click',function(){S.textColor=b.getAttribute('data-color')||'';applySettings();saveSettings()})});
  on($('switch-conv'),'change',function(e){setConv(e.target.checked)});
  on($('cache-clear'),'click',clearCache);
  /* 替换规则 */
  on($('rep-add-btn'),'click',function(){
    var f=$('rep-f'),t=$('rep-t');
    var fv=f.value.trim(),tv=t.value;
    if(!fv){toast('请输入要查找的文本');f.focus();return}
    var rules=getRepRules();
    rules.push({f:fv,t:tv,on:true,ts:Date.now()});
    saveRepRules(rules);
    f.value='';t.value='';
    renderRepList();updateRepSwitch();rerenderCurrent();
    toast('已添加替换规则');
    triggerImmediateSync();
  });
  on($('rep-f'),'keydown',function(e){if(e.key==='Enter')$('rep-t').focus()});
  on($('rep-t'),'keydown',function(e){if(e.key==='Enter')$('rep-add-btn').click()});
  on($('rep-list'),'click',function(e){
    var tg=e.target.closest('.rep-toggle');
    if(tg){
      var i=+tg.dataset.i;
      var rules=getRepRules();rules[i].on=!rules[i].on;rules[i].ts=Date.now();
      saveRepRules(rules);renderRepList();updateRepSwitch();rerenderCurrent();
      triggerImmediateSync();
      return;
    }
    var del=e.target.closest('.rep-del');
    if(del){
      var j=+del.dataset.i;
      var r2=getRepRules();
      var removed=r2.splice(j,1)[0];
      if(removed&&removed.f&&S.fileName){
        var delRep=[];
        try{delRep=JSON.parse(localStorage.getItem('jd_del_rep_'+S.fileName)||'[]')}catch(e){}
        delRep.push({f:removed.f,ts:Date.now()});
        try{localStorage.setItem('jd_del_rep_'+S.fileName,JSON.stringify(delRep.slice(-50)))}catch(e){}
      }
      saveRepRules(r2);renderRepList();updateRepSwitch();rerenderCurrent();
      triggerImmediateSync();
    }
  });
  on($('switch-rep'),'change',function(e){
    var on2=e.target.checked;
    var rules=getRepRules();
    for(var i=0;i<rules.length;i++){rules[i].on=on2;rules[i].ts=Date.now()}
    saveRepRules(rules);renderRepList();rerenderCurrent();
    triggerImmediateSync();
  });
  /* 高亮词 */
  initHlColors();
  on($('hl-add-btn'),'click',function(){
    var inp=$('hl-input'),v=inp.value.trim();
    if(!v){toast('请输入要高亮的词');inp.focus();return}
    var ws=getHlList();
    for(var i=0;i<ws.length;i++){if(ws[i].w===v){toast('该词已存在');return}}
    ws.push({w:v,c:selHlColor(),ts:Date.now()});
    saveHlList(ws);
    inp.value='';
    renderHlList();rerenderCurrent();
    toast('已添加高亮词');
    triggerImmediateSync();
  });
  on($('hl-input'),'keydown',function(e){if(e.key==='Enter')$('hl-add-btn').click()});
  on($('hl-list'),'click',function(e){
    var del=e.target.closest('.hl-del');
    if(!del)return;
    var i=+del.dataset.i;
    var ws=getHlList();
    var removed=ws.splice(i,1)[0];
    if(removed&&removed.w&&S.fileName){
      var delHl=[];
      try{delHl=JSON.parse(localStorage.getItem('jd_del_hl_'+S.fileName)||'[]')}catch(e){}
      delHl.push({w:removed.w,ts:Date.now()});
      try{localStorage.setItem('jd_del_hl_'+S.fileName,JSON.stringify(delHl.slice(-50)))}catch(e){}
    }
    saveHlList(ws);renderHlList();rerenderCurrent();
    triggerImmediateSync();
  });
  /* 番茄钟时长 */
  on($('range-pomo'),'input',function(e){S.pomoMin=+e.target.value;saveSettings();var v=$('val-pomo');if(v)v.textContent=S.pomoMin+' 分钟'});
  /* 常驻章节标题开关 */
  on($('switch-sticky'),'change',function(e){S.stickyHead=e.target.checked;applySettings();saveSettings()});
  /* 划词翻译设置 */
  on($('switch-trans'),'change',function(e){
    var on=e.target.checked;
    setTransActive(on);
    if(!on&&_selToolbar){
      _selToolbar.classList.remove('show-trans');
      repositionSelToolbar();
    }
    toast(on?'已开启划词翻译（当前会话有效）':'已关闭划词翻译');
  });
  var swTransWrap=$('switch-trans')?$('switch-trans').closest('.switch'):null;
  if(swTransWrap)on(swTransWrap,'click',function(e){e.stopPropagation()});
  var selTransEng=$('select-trans-engine');
  if(selTransEng){
    on(selTransEng,'change',function(){S.transEngine=selTransEng.value;saveSettings()});
  }
  /* WebDAV 关书同步策略 */
  var selSync=$('select-dav-sync');
  if(selSync){
    selSync.value=S.davSyncMode||'auto';
    on(selSync,'change',function(){S.davSyncMode=selSync.value;saveSettings()});
  }
  /* 书籍标签管理 */
  on($('cat-add-btn'),'click',function(){
    var inp=$('cat-input'),v=inp.value.trim();
    if(!v){toast('请输入标签名');inp.focus();return}
    var cats=getCats();
    for(var ci=0;ci<cats.length;ci++){if(cats[ci].n===v){toast('标签已存在');return}}
    cats.push({n:v,c:POMO_COLORS[cats.length%POMO_COLORS.length]});saveCats(cats);
    inp.value='';renderCatList();renderBookshelf();
    toast('已添加标签');
  });
  on($('cat-input'),'keydown',function(e){if(e.key==='Enter')$('cat-add-btn').click()});
  on($('cat-list'),'click',function(e){
    var el=$('cat-list');
    var sw=e.target.closest('.cat-swatch');
    if(sw){
      var si=+sw.dataset.i;
      el.querySelectorAll('.cat-colors').forEach(function(x){x.classList.toggle('open',+x.dataset.i===si)});
      return;
    }
    var col=e.target.closest('.cat-color');
    if(col){
      var ci2=+col.dataset.i;
      var cats0=getCats();
      if(cats0[ci2]){cats0[ci2].c=col.dataset.c;saveCats(cats0);renderCatList();renderBookshelf()}
      return;
    }
    var del=e.target.closest('.cat-del');
    if(del){
      var i=+del.dataset.i;
      var cats=getCats(),c=cats[i];if(!c)return;
      confirmBox('删除标签「'+c.n+'」？该标签下书籍将变为未分类。','删除',function(){
        cats.splice(i,1);saveCats(cats);
        var lib=getLib();
        for(var j=0;j<lib.length;j++){if(lib[j].cat===c.n)lib[j].cat=''}
        saveLib(lib);
        renderCatList();renderBookshelf();
        toast('已删除标签');
      });
      return;
    }
    var nm=e.target.closest('.cat-name');
    if(nm){
      var i2=+nm.dataset.i;
      var item=getCats()[i2];if(!item)return;
      var old=item.n;
      var inp=document.createElement('input');
      inp.type='text';inp.maxLength=12;inp.value=old;
      nm.replaceWith(inp);inp.focus();inp.select();
      var done=function(){
        var v=inp.value.trim();
        if(v&&v!==old){
          var cats2=getCats();cats2[i2].n=v;saveCats(cats2);
          var lib2=getLib();
          for(var k=0;k<lib2.length;k++){if(lib2[k].cat===old)lib2[k].cat=v}
          saveLib(lib2);
        }
        renderCatList();renderBookshelf();
      };
      on(inp,'blur',done);
      on(inp,'keydown',function(ev){
        if(ev.key==='Enter'){ev.preventDefault();inp.blur()}
        if(ev.key==='Escape'){inp.value=old;inp.blur()}
      });
    }
  });
  /* 折叠组内 summary 的开关点击不触发展开/收起 */
  document.querySelectorAll('#settings details.fold summary').forEach(function(sm){
    on(sm,'click',function(e){
      if(e.target.closest('.switch'))e.preventDefault();
    });
  });
  renderRepList();renderHlList();renderCatList();
  updateCacheStats();
}

function setupEvents(){
  on($('bs-main'),'click',function(e){var c=e.target.closest('.bs-card');if(!c)return;var n=c.dataset.name;if(!n)return;if(e.target.closest('.bs-card-del')){deleteBook(n)}else if(e.target.closest('.bs-card-download')){downloadBook(n)}else if(e.target.closest('.bs-card-cat')){openCatPop(n,e)}else{loadBookFromShelf(n)}});
  on($('bs-import'),'click',function(e){
    e.stopPropagation();
    if(!window.WebDAV||!window.WebDAV.isConfigured||!window.WebDAV.isConfigured()){
      fileInput.click();
      return;
    }
    importDropdownMenu.classList.toggle('show');
  });
  on($('import-local'),'click',function(e){
    e.stopPropagation();
    importDropdownMenu.classList.remove('show');
    fileInput.click();
  });
  on(fileInput,'change',function(){var f=fileInput.files[0];if(f)handleFile(f);fileInput.value=''});
  on(document,'mousedown',function(e){
    if(!e.target.closest('.import-dropdown')){
      importDropdownMenu.classList.remove('show');
    }
  });
  on($('bs-theme-btn'),'click',toggleTheme);
  on($('bs-title'),'click',handleHiddenShelfClick);
  on($('bs-settings-btn'),'click',function(){showBookshelfSettings()});
  on(bookshelfSearch,'input',debounce(renderBookshelf,SEARCH_DELAY));
  on(bookshelfSort,'change',function(){S.librarySort=bookshelfSort.value;saveSettings();renderBookshelf()});
  on($('bs-cat'),'change',function(){S.libraryCat=$('bs-cat').value;saveSettings();renderBookshelf()});
  on($('cat-pop-list'),'click',function(e){var b=e.target.closest('.cat-pop-item');if(b)setBookCat(b.dataset.cat)});
  on(document,'dragover',function(e){e.preventDefault()});
  on(document,'drop',function(e){e.preventDefault();if(e.dataTransfer&&e.dataTransfer.files[0])handleFile(e.dataTransfer.files[0])});
  on(contentEl,'click',function(e){
    var ant=e.target.closest('.ant');
    if(ant){_touchTap=false;showAntPop(ant);e.stopPropagation();return}
    if(_touchTap){_touchTap=false;return}
    if(toolbar.classList.contains('visible')){toolbar.classList.remove('visible');progressTrack.classList.remove('active');syncSearchBar()}else{var r=contentEl.getBoundingClientRect();if(e.clientY-r.top<r.height*.5){toolbar.classList.add('visible');progressTrack.classList.add('active');syncSearchBar();updateToolbarTime()}}});
  on(contentEl,'scroll',function(){if(!isAdjusting)afterScroll()},{passive:true});
  on($('btn-home'),'click',showBookshelf);
  on($('btn-toc'),'click',function(){togglePanel('sidebar');if(sidebar.classList.contains('open'))closeSearch()});
  on(sidebarOverlay,'click',function(){togglePanel('sidebar',false)});
  on($('btn-settings'),'click',function(){togglePanel('settings')});
  on(settingsOverlay,'click',function(){togglePanel('settings',false)});
  on($('btn-theme'),'click',toggleTheme);
  on($('btn-search'),'click',function(){searchBar.classList.contains('open')?closeSearch():openSearch()});
  on($('btn-bm'),'click',toggleBookmark);
  on($('s-prev'),'click',searchPrev);on($('s-next'),'click',searchNext);on($('s-close'),'click',closeSearch);
  on(searchInput,'input',debounce(doSearch,SEARCH_DELAY));
  on(searchInput,'keydown',function(e){if(e.key==='Enter'){e.shiftKey?searchPrev():searchNext()}if(e.key==='Escape')closeSearch()});
  document.querySelectorAll('.stab').forEach(function(b){on(b,'click',function(){document.querySelectorAll('.stab').forEach(function(x){x.classList.remove('active')});document.querySelectorAll('.stab-panel').forEach(function(x){x.classList.remove('active')});b.classList.add('active');var pn=b.dataset.tab==='toc'?'toc-panel':(b.dataset.tab==='ant'?'ant-panel':'bm-panel');var p=$(pn);if(p)p.classList.add('active');if(b.dataset.tab==='ant')renderAnnotations()})});
  setupSettingsEvents();
  on(window,'orientationchange',preserveReaderViewport);
  on(window,'resize',preserveReaderViewport);
  if(window.visualViewport)on(window.visualViewport,'resize',preserveReaderViewport);
  on(window,'beforeunload',function(){stopReadingTimer();if(S.fileName)saveProg()});
  on(document,'visibilitychange',function(){if(document.hidden){if(reader.classList.contains('active'))stopReadingTimer()}else{if(reader.classList.contains('active'))startReadingTimer()}});
  var tx=0,ty=0,_lastTapTs=0;
  on(contentEl,'touchstart',function(e){
    /* 多指手势（捏合缩放）直接拦截，避免滑动翻页时误触发 */
    if(e.touches.length>1){e.preventDefault();return}
    tx=e.touches[0].clientX;ty=e.touches[0].clientY;_touchTap=false;closeTip();
  },{passive:false});
  var HIDE_THRESHOLD=50;
  on(contentEl,'touchmove',function(e){
    if(e.touches.length>1){e.preventDefault();return}
    if(!S.chapters.length)return;
    var dy=e.touches[0].clientY-ty;
    if(dy<-HIDE_THRESHOLD&&(toolbar.classList.contains('visible')||progressTrack.classList.contains('active'))){
      toolbar.classList.remove('visible');progressTrack.classList.remove('active');syncSearchBar();
    }
  },{passive:false});
  on(contentEl,'wheel',function(e){
    /* 桌面触控板/Ctrl+滚轮缩放 */
    if(e.ctrlKey){e.preventDefault();return}
    if(e.deltaY>0&&(toolbar.classList.contains('visible')||progressTrack.classList.contains('active'))){
      toolbar.classList.remove('visible');progressTrack.classList.remove('active');syncSearchBar();
    }
  },{passive:false});
  /* 阻止双击放大：两次轻触间隔过短时吞掉第二次 */
  on(contentEl,'touchend',function(e){
    var now=Date.now();
    if(now-_lastTapTs<320){e.preventDefault();_lastTapTs=0;return}
    _lastTapTs=now;
  },{passive:false});
  function touchEndTap(e){
    if(!S.chapters.length)return;
    if(e.changedTouches.length!==1)return;
    /* 文本选择：出现非折叠选区时显示划线工具条，不触发翻页 */
    var sel=window.getSelection();
    if(sel&&!sel.isCollapsed&&sel.rangeCount){
      var ar=getSelAntRange();
      if(ar){showSelToolbar();return}
    }
    var dx=e.changedTouches[0].clientX-tx,dy=e.changedTouches[0].clientY-ty;
    if(Math.abs(dx)<20&&Math.abs(dy)<20){
      var r=contentEl.getBoundingClientRect(),y=e.changedTouches[0].clientY-r.top;
      if(y>r.height*.5){
        _touchTap=true;
        var x=e.changedTouches[0].clientX-r.left;
        if(x<r.width*.15){goToChapter(Math.max(0,S.currentChapter-1))}
        else if(x>r.width*.85){goToChapter(Math.min(S.chapters.length-1,S.currentChapter+1))}
      }
    }
  }
  on(contentEl,'touchend',touchEndTap,{passive:true});
  /* iOS Safari 手势事件 */
  on(document,'gesturestart',function(e){e.preventDefault()},{passive:false});
  on(document,'gesturechange',function(e){e.preventDefault()},{passive:false});
  on(document,'gestureend',function(e){e.preventDefault()},{passive:false});
  on(document,'keydown',function(e){
    if(window.WebDAV&&window.WebDAV.isOpen()){
      if(e.key==='Escape'){e.preventDefault();window.WebDAV.hide();return}
      window.WebDAV.trapFocus(e);return;
    }
    if(e.key==='Escape'){closeAllPanels();hideAntPop();hideSelToolbar();closeCatPop();_selCache=null}
    if((e.ctrlKey||e.metaKey)&&e.key==='f'){e.preventDefault();openSearch()}
  });
  on(document,'mousedown',function(e){
    if(_selToolbar&&_selToolbar.classList.contains('show')&&!e.target.closest('#sel-toolbar')){hideSelToolbar();_selCache=null}
    if(_antPop&&_antPop.classList.contains('show')&&!e.target.closest('#ant-pop')){hideAntPop()}
    if(_catPop&&_catPop.classList.contains('show')&&!e.target.closest('#cat-pop')){closeCatPop()}
  });
  on(document,'mouseup',function(){
    setTimeout(function(){
      if(!reader.classList.contains('active'))return;
      var sel=window.getSelection();
      if(sel&&!sel.isCollapsed&&sel.rangeCount&&getSelAntRange())showSelToolbar();
      else hideSelToolbar();
    },0);
  });
  on(document,'click',function(e){var tip=document.querySelector('.ft-tip.show');if(tip&&!tip.contains(e.target)&&!e.target.closest('a[epub\\:type="noteref"]')){closeTip()}});
  /* 切后台、锁屏、切标签页时自动静默保存与同步 */
  on(document,'visibilitychange',function(){
    if(document.visibilityState==='hidden'){
      handleBackgroundSync();
    }
  });
  on(window,'pagehide',function(){
    handleBackgroundSync();
  });
  on(window,'beforeunload',function(){
    handleBackgroundSync();
  });
  initSelToolbar();initAntPop();initPomo();
}
var _hiddenShelfTaps=0,_hiddenShelfTapTimer=null;
function handleHiddenShelfClick(){
  _hiddenShelfTaps++;
  clearTimeout(_hiddenShelfTapTimer);
  if(_hiddenShelfTaps>=5){_hiddenShelfTaps=0;toggleHiddenShelf();return}
  _hiddenShelfTapTimer=setTimeout(function(){_hiddenShelfTaps=0},650);
}
function togglePanel(n,force){if(n==='sidebar'){var o=force!==undefined?force:!sidebar.classList.contains('open');sidebar.classList.toggle('open',o);sidebarOverlay.classList.toggle('show',o);var sw=o?sidebar.offsetWidth+'px':'';toolbar.style.left=sw;searchBar.style.left=sw;if(o){highlightToc();renderAnnotations()}}else{var o2=force!==undefined?force:!settingsEl.classList.contains('open');settingsEl.classList.toggle('open',o2);settingsOverlay.classList.toggle('show',o2);if(o2){updateSettingsScope();updateStatsDisplay();updateCacheStats();renderRepList();renderHlList();updateRepSwitch()}}}
/* 设置面板按上下文（阅读中 / 书架）显示对应分组；forceReader 显式指定上下文，避免依赖 reader 状态判断 */
function updateSettingsScope(forceReader){
  var inReader=forceReader!==undefined?forceReader:!!(reader&&reader.classList.contains('active'));
  document.querySelectorAll('#settings .settings-group').forEach(function(g){
    var sc=g.getAttribute('data-scope');
    if(sc==='reader')g.style.display=inReader?'':'none';
    else if(sc==='shelf')g.style.display=inReader?'none':'';
    else g.style.display='';
  });
}
function showBookshelfSettings(){settingsEl.classList.add('open');settingsOverlay.classList.add('show');updateSettingsScope(false);updateStatsDisplay();updateCacheStats()}

/* ===== Helpers ===== */
function showLoading(m){if(loading){loading.classList.add('show');if(loadingText)loadingText.textContent=m||'加载中...'}}
function hideLoading(){if(loading)loading.classList.remove('show')}
function showReader(){hideBookshelf();buildTOC();if(reader)reader.classList.add('active');updateReaderTitle();var bm=$('btn-bm');if(bm){bm.classList.remove('on');var sv=bm.querySelector('svg');if(sv)sv.setAttribute('fill','none')}requestAnimationFrame(function(){hideLoading()});startReadingTimer();renderBookmarks();renderAnnotations();renderHlList();renderRepList();updateRepSwitch()}
function fmtSize(b){return b<1024?b+'B':b<1048576?(b/1024).toFixed(1)+'KB':(b/1048576).toFixed(1)+'MB'}
function toast(msg){if(!toastEl)return;toastEl.textContent=msg;toastEl.classList.add('show');clearTimeout(toastEl._t);toastEl._t=setTimeout(function(){toastEl.classList.remove('show')},TOAST_MS)}
/* ===== 确认弹框（替代原生 confirm，渐入渐出） ===== */
var _confirmCleanup=null;
function confirmBox(msg,okText,onOk){
  if(!confirmOverlay||confirmOverlay.classList.contains('show'))return;
  confirmMsg.textContent=msg;
  confirmOkBtn.textContent=okText||'确定';
  confirmOverlay.classList.add('show');
  confirmOverlay.setAttribute('aria-hidden','false');
  confirmCancelBtn.focus();
  var ok=function(){closeConfirmBox();if(onOk)onOk()};
  var cancel=function(){closeConfirmBox()};
  var onOverlay=function(e){if(e.target===confirmOverlay)cancel()};
  var onKey=function(e){if(e.key==='Escape')cancel();else if(e.key==='Enter')ok()};
  _confirmCleanup=function(){
    confirmOkBtn.removeEventListener('click',ok);
    confirmCancelBtn.removeEventListener('click',cancel);
    confirmOverlay.removeEventListener('click',onOverlay);
    document.removeEventListener('keydown',onKey);
  };
  confirmOkBtn.addEventListener('click',ok);
  confirmCancelBtn.addEventListener('click',cancel);
  confirmOverlay.addEventListener('click',onOverlay);
  document.addEventListener('keydown',onKey);
}
function closeConfirmBox(){
  if(!confirmOverlay||!confirmOverlay.classList.contains('show'))return;
  confirmOverlay.classList.remove('show');
  confirmOverlay.setAttribute('aria-hidden','true');
  if(_confirmCleanup){_confirmCleanup();_confirmCleanup=null}
}
function debounce(fn,ms){var t;return function(){var a=arguments,c=this;clearTimeout(t);t=setTimeout(function(){fn.apply(c,a)},ms)}}
function getStats(){try{return JSON.parse(localStorage.getItem('jd_stats')||'{"totalMin":0,"todayMin":0,"date":"","monthMin":0,"month":"","sessions":0,"books":{}}')}catch(e){return{totalMin:0,todayMin:0,date:'',monthMin:0,month:'',sessions:0,books:{}}}}
function saveStats(s){try{localStorage.setItem('jd_stats',JSON.stringify(s))}catch(e){}}
function updateStatsDisplay(){var s=getStats(),b=s.books[S.fileName],ym=new Date().toISOString().slice(0,7);if(s.month!==ym)s.monthMin=0;var m=$('stats-month'),t=$('stats-total'),d=$('stats-today'),bk=$('stats-book');if(m)m.textContent=s.monthMin+' 分钟';if(t)t.textContent=s.totalMin+' 分钟';if(d)d.textContent=s.todayMin+' 分钟';if(bk)bk.textContent=(b?b.min:0)+' 分钟'}
function tickReading(){if(!_rs)return;var now=Date.now(),elapsed=Math.floor((now-_rs)/60000);if(elapsed<1)return;var s=getStats(),today=new Date().toISOString().slice(0,10),ym=today.slice(0,7);if(s.date!==today){s.todayMin=0;s.date=today}if(s.month!==ym){s.monthMin=0;s.month=ym}s.totalMin+=elapsed;s.todayMin+=elapsed;s.monthMin+=elapsed;if(S.fileName){if(!s.books[S.fileName])s.books[S.fileName]={min:0,opens:0};s.books[S.fileName].min+=elapsed;if(reader&&reader.classList.contains('active')&&isCurrentBookWebdav()&&S.davSyncMode!=='off'&&davSyncAvailable()){saveProg();davUploadCheckpoint(S.fileName)}}saveStats(s);_rs=now;updateStatsDisplay()}
function updateToolbarTime(){}
function startReadingTimer(){stopReadingTimer();_rs=Date.now();_rt=setInterval(tickReading,60000);_rtSec=setInterval(updateToolbarTime,10000);var s=getStats();s.sessions++;saveStats(s);updateStatsDisplay();updateToolbarTime()}
function stopReadingTimer(){if(_rt){clearInterval(_rt);_rt=null}if(_rtSec){clearInterval(_rtSec);_rtSec=null}tickReading();_rs=0;updateToolbarTime()}
function updateCacheStats(){var l=getLib().filter(function(b){return!!b.pv===S.hiddenShelf}),t=0;for(var i=0;i<l.length;i++)t+=l[i].s||0;$('cache-info').textContent='缓存 '+l.length+' 本书，占用 '+fmtSize(t)}
/* 清空当前书籍的内存状态（与缓存/书籍删除共用） */
function resetBookState(){
  S.fileName='';S.fileSize=0;S.fileType='';S.rawText='';
  S.chapters=[];S.currentChapter=0;S.epubCSS='';S.epubTitle='';S.toc=null;
  S.storeMode='inline';S.searchQuery='';S.searchResults=[];S.searchIdx=-1;
  firstLoaded=-1;lastLoaded=-1;_progData=null;_textCache=null;_textCacheLen=0;_tocItems=[];
  if(contentInner)contentInner.innerHTML='';
}
function clearBookStorage(){
  /* 仅清书籍相关 localStorage：书架、进度、书签；不动设置、隐藏书架状态、统计和 WebDAV。 */
  try{localStorage.removeItem('jd_lib')}catch(e){}
  try{localStorage.removeItem('jd_p')}catch(e){}
  try{
    var keys=[];
    for(var i=0;i<localStorage.length;i++){
      var k=localStorage.key(i);
      if(k&&k.indexOf('jd_bm_')===0)keys.push(k);
    }
    for(var j=0;j<keys.length;j++)localStorage.removeItem(keys[j]);
  }catch(e){}
}
function clearCache(){
  confirmBox('确定清除所有书籍缓存？进度与书签也会删除，需要重新导入才能阅读。','清除',function(){
  dbClearAll(function(ok){
    if(!ok){toast('数据库不可用');return}
    clearBookStorage();
    /* 若正在阅读，退回书架 */
    if(reader&&reader.classList.contains('active')){
      stopReadingTimer();
      closeSearch();
      togglePanel('sidebar',false);
      togglePanel('settings',false);
      clearEpubCSS();
      closeTip();
      reader.classList.remove('active');
      bookshelf.classList.remove('hide');
    }
    resetBookState();
    renderBookshelf();updateCacheStats();toast('缓存已清除');
  });
  });
}
function toggleTheme(){S.theme=S.theme==='light'?'dark':'light';applySettings();saveSettings()}
function closeAllPanels(){togglePanel('sidebar',false);togglePanel('settings',false);if(searchBar.classList.contains('open'))closeSearch()}
function goToChapter(idx,after){
  if(idx<0||idx>=S.chapters.length)return;
  togglePanel('sidebar',false);
  toolbar.classList.remove('visible');
  progressTrack.classList.remove('active');
  syncSearchBar();
  /* after 在布局稳定并滚到章节后执行（锚点/书签偏移） */
  initSeamless(idx,0,after);
}
var _ftMap=null,_ftTipEl=null,_ftActiveRef=null,_epubHandlersSetup=false;
function processFootnotes(){
  if(!_ftTipEl){
    _ftTipEl=document.createElement('div');_ftTipEl.className='ft-tip';
    _ftTipEl.innerHTML='<div class="ft-tip-content"></div>';
    document.body.appendChild(_ftTipEl);
    on(contentInner,'click',function(e){
      var a=e.target.closest('a[epub\\:type="noteref"]');
      if(!a)return;
      var href=a.getAttribute('href');
      if(!href||!href.startsWith('#'))return;
      var id=href.slice(1);var text=_ftMap?_ftMap[id]:null;
      if(!text)return;
      e.preventDefault();e.stopImmediatePropagation();
      if(_ftActiveRef===a){_ftTipEl.classList.remove('show');_ftActiveRef=null;return}
      _showFtTip(a,text);
    });
  }
  _scanFootnotes();
  return{map:_ftMap,hideTip:function(){if(_ftTipEl)_ftTipEl.classList.remove('show');_ftActiveRef=null},showTip:_showFtTip};
}
function _showFtTip(ref,text){
  var tc=_ftTipEl.querySelector('.ft-tip-content');
  tc.textContent=text;_ftTipEl.classList.add('show');
  var rect=ref.getBoundingClientRect();
  var tw=_ftTipEl.offsetWidth,th=_ftTipEl.offsetHeight;
  var left=rect.left+(rect.width-tw)/2;
  var top=rect.bottom+8;
  if(left<8)left=8;if(left+tw>window.innerWidth-8)left=window.innerWidth-tw-8;
  if(top+th>window.innerHeight-8)top=rect.top-th-8;
  _ftTipEl.style.left=left+'px';_ftTipEl.style.top=top+'px';
  _ftActiveRef=ref;
}
function closeTip(){if(_ftTipEl){_ftTipEl.classList.remove('show');_ftActiveRef=null}}
/* 扫描当前已渲染章节中的脚注，重建 href-id 映射（渲染时调用，见 appendChapter/prependChapter） */
function _scanFootnotes(){
  _ftMap={};
  contentInner.querySelectorAll('aside').forEach(function(aside){
    if(aside.getAttribute('epub:type')==='footnote'){
      var id=aside.getAttribute('id');
      if(id){var li=aside.querySelector('.duokan-footnote-item,li');_ftMap[id]=li?li.textContent.trim():aside.textContent.trim();aside.classList.add('footnote-hidden')}
    }
  });
}
function setupEpubLinkHandler(){
  if(_epubHandlersSetup)return;
  _epubHandlersSetup=true;
  on(contentInner,'click',function(e){
    var a=e.target.closest('a');
    if(!a)return;
    var href=a.getAttribute('href');
    if(!href)return;
    if(href.startsWith('#')){
      var id=href.slice(1);
      var el=contentInner.querySelector('[id="'+id+'"]')||contentInner.querySelector('[name="'+id+'"]');
      if(el){e.preventDefault();scrollToElement(el,60)}
      return;
    }
    if(/^(https?:|javascript:|data:)/i.test(href)){e.preventDefault();return}
    var anchor=href.split('#')[1]||'';
    var chIdx=findChapterByHref(href);
    if(chIdx>=0){
      e.preventDefault();
      goToChapter(chIdx,function(){
        if(!anchor)return;
        var safe=anchor.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
        var el2=contentInner.querySelector('[id="'+safe+'"]')||contentInner.querySelector('[name="'+safe+'"]');
        if(el2)scrollToElement(el2,60);
      });
      return;
    }
    e.preventDefault();
  });
}
window.J={
  go:function(ch,off){
    goToChapter(ch,function(){
      if(off)scrollToChapter(ch,off);
    });
  },
  delBm:deleteBookmark,
  goToc:goToc,
  closeTip:closeTip,
  goAnt:function(i){
    var ants=getAnnotations(),a=ants[i];
    if(!a)return;
    goToChapter(a.ch,function(){
      var el=contentInner.querySelector('.ant[data-s="'+a.start+'"]');
      if(el)scrollToElement(el,80);
    });
  },
  delAnt:function(i){
    var ants=getAnnotations();
    var a=ants[i];
    if(a&&S.fileName){
      var delAnts=[];
      try{delAnts=JSON.parse(localStorage.getItem('jd_del_ant_'+S.fileName)||'[]')}catch(e){}
      delAnts.push({sig:getAntSig(a),ts:Date.now()});
      try{localStorage.setItem('jd_del_ant_'+S.fileName,JSON.stringify(delAnts.slice(-50)))}catch(e){}
    }
    ants.splice(i,1);
    saveAnnotations(ants);
    renderAnnotations();
    if(reader.classList.contains('active'))rerenderChapterBlock(S.currentChapter);
    toast('已删除划线');
    triggerImmediateSync();
  },
  goToHeading:function(chIdx,hIdx){
    goToChapter(chIdx,function(){
      var el=contentInner.querySelector('[id="ch-'+chIdx+'-h-'+hIdx+'"]');
      if(el)scrollToElement(el,60);
    });
  }
};

/* ===== 导出共享 API（供 webdav.js / epub.js 使用） ===== */
window.S=S;
window.toast=toast;window.showLoading=showLoading;window.hideLoading=hideLoading;
window.fmtSize=fmtSize;window.openDB=openDB;window.dbSave=dbSave;window.addToLib=addToLib;
window.decodeBuffer=decodeBuffer;window.generateCoverDataUrl=generateCoverDataUrl;
window.processContent=processContent;window.finishEpubImport=finishEpubImport;
window.parseEPUB=parseEPUB;window.PROC_DELAY=PROC_DELAY;
window.davSyncAvailable=davSyncAvailable;window.davDownloadCheckpoint=davDownloadCheckpoint;
window.davRemoteAhead=davRemoteAhead;window.davApplyRemoteData=davApplyRemoteData;
window.loadProg=loadProg;window.jumpToPercent=jumpToPercent;
window.renderBookmarks=renderBookmarks;window.rerenderCurrent=rerenderCurrent;
window.getHlList=getHlList;window.getRepRules=getRepRules;window.renderHlList=renderHlList;window.renderRepList=renderRepList;window.renderCatList=renderCatList;
window.confirmBox=confirmBox;
window.mergeBookmarks=mergeBookmarks;window.mergeAnnotations=mergeAnnotations;window.isCurrentBookWebdav=isCurrentBookWebdav;
window.mergeHlList=mergeHlList;window.mergeRepRules=mergeRepRules;
window.clearBookCache=clearBookCache;window.renderAnnotations=renderAnnotations;window.updateRepSwitch=updateRepSwitch;

})();
