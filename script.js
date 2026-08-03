(function(){
'use strict';

var S={fileName:'',fileSize:0,fileType:'',rawText:'',chapters:[],currentChapter:0,epubCSS:'',epubTitle:'',toc:null,theme:'light',fontSize:18,lineHeight:1.85,padding:'normal',textColor:'',searchQuery:'',searchResults:[],searchIdx:-1,privacyMode:false,storeMode:'inline'};
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
var firstLoaded=-1,lastLoaded=-1,isAdjusting=false,_progData=null,_rs=0,_rt=null,_rtSec=null,_touchTap=false;
var importDropdownMenu=$('import-dropdown-menu'),webdavModal=$('webdav-modal'),webdavModalTitle=$('webdav-modal-title');
var webdavStepUrl=$('webdav-step-url'),webdavStepAuth=$('webdav-step-auth'),webdavStepBrowse=$('webdav-step-browse');
var webdavUrlInput=$('webdav-url'),webdavUsernameInput=$('webdav-username'),webdavPasswordInput=$('webdav-password'),webdavRememberCheckbox=$('webdav-remember');
var webdavBreadcrumb=$('webdav-breadcrumb'),webdavFileList=$('webdav-file-list');
var webdavBaseUrl='',webdavAuth='',webdavCurrentPath='/',webdavCredentials={url:'',username:'',password:'',remember:true};
var coverHues=[25,42,120,175,210,260,330,15,55,150,200,280,350,80,300,10];
var CH_HEADING_GAP=10,BM_OFFSET_TOL=200,SCROLL_BOUND=800,PARA_MAX=4000,SAVE_DELAY=800,PROC_DELAY=30,TOAST_MS=1800,SEARCH_DELAY=200,SNIP_MAX=100,TRIM_WIN=4;

function on(el,ev,fn,opt){if(el)el.addEventListener(ev,fn,opt||false)}
loadSettings();loadPrivacyMode();applySettings();updatePrivacyUI();setupEvents();setupProgressDrag();renderBookshelf();

/* ===== IndexedDB（连接单例 + 章节分表 v2） =====
 * books: 元数据 + 轻量 chaptersMeta；大 HTML 不再整本塞进一条记录
 * chapters: keyPath [book, idx]，按需加载 html/text
 * 兼容 v1：books.chapters 仍含全文时走 legacy 内存模式
 */
var DBN='JingDuV2',DBV=2,STORE='books',CH_STORE='chapters';
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
      var t=(row.text||'').toLowerCase();
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
function addToLib(n,s,tp,cv){var l=getLib().filter(function(b){return b.n!==n});l.unshift({n:n,s:s,tp:tp,ts:Date.now(),cv:cv||null,pv:S.privacyMode?true:false});saveLib(l)}
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

/* ===== EPUB Parser ===== */
var FONT_TYPES=/^font\/|^application\/font|^application\/x-font/;
var CSS_TYPE='text/css';
function parseEPUB(buf,cb){
  if(typeof JSZip==='undefined'){cb(null,'EPUB 支持库未加载，请检查网络');return}
  try{
    JSZip.loadAsync(buf).then(function(zip){
      var container=zip.file('META-INF/container.xml');
      if(!container){cb(null,'无效的 EPUB 文件');return}
      return container.async('text').then(function(xml){
        var doc=new DOMParser().parseFromString(xml,'application/xml');
        var rf=doc.querySelector('rootfile');if(!rf){cb(null,'无法找到内容文件');return}
        var opfPath=rf.getAttribute('full-path');
        var opfDir=opfPath.substring(0,opfPath.lastIndexOf('/')+1);
        return zip.file(opfPath).async('text').then(function(opfText){
          var opf=new DOMParser().parseFromString(opfText,'application/xml');
          var titleEl=opf.querySelector('title');
          var title=titleEl?titleEl.textContent.trim():'';
          var manifest={};
          opf.querySelectorAll('manifest item').forEach(function(it){
            manifest[it.getAttribute('id')]={href:opfDir+it.getAttribute('href'),type:it.getAttribute('media-type')||'',props:it.getAttribute('properties')||''};
          });
          var coverId=null;
          var cm=opf.querySelector('meta[name="cover"]');if(cm)coverId=cm.getAttribute('content');
          if(!coverId)for(var id in manifest)if(manifest[id].props.indexOf('cover-image')>=0){coverId=id;break}
          if(!coverId)for(var id2 in manifest)if(/cover/i.test(id2)&&manifest[id2].type.indexOf('image')>=0){coverId=id2;break}
          var spine=[];opf.querySelectorAll('spine itemref').forEach(function(r){spine.push(r.getAttribute('idref'))});
          var coverP=Promise.resolve(null);
          if(coverId&&manifest[coverId]){
            var cf=zip.file(manifest[coverId].href);
            if(cf)coverP=cf.async('base64').then(function(b){return'data:'+manifest[coverId].type+';base64,'+b}).catch(function(){return null});
          }
          /* ---- TOC (NCX) extraction ---- */
          var ncxP=Promise.resolve(null);
          var ncxItem=null;
          for(var mid in manifest){if(manifest[mid].type==='application/x-dtbncx+xml'||/\.ncx$/i.test(manifest[mid].href)){ncxItem=manifest[mid];break}}
          if(ncxItem){
            var nf=zip.file(ncxItem.href);
            var ncxDir=ncxItem.href.substring(0,ncxItem.href.lastIndexOf('/')+1);
            if(nf)ncxP=nf.async('text').then(function(ncxText){
              var ncxDoc=new DOMParser().parseFromString(ncxText,'application/xml');
              var navMap=ncxDoc.querySelector('navMap');
              if(navMap){
                var toc=[];
                function parseNavPoint(np,level){
                  var label=np.querySelector('navLabel text');
                  var content=np.querySelector('content');
                  if(label&&content){
                    var src=content.getAttribute('src')||'';
                    var hash=src.indexOf('#')>=0?src.substring(src.indexOf('#')):'';
                    var hrefBase=src?src.split('#')[0]:'';
                    /* 相对 NCX 所在目录解析，与 spine 的 item.href 对齐 */
                    var fullHref=hrefBase?resolvePath(ncxDir,hrefBase):'';
                    toc.push({title:label.textContent.trim(),href:fullHref+hash,level:level||0,playOrder:np.getAttribute('playOrder')});
                  }
                  var children=np.querySelectorAll(':scope > navPoint');
                  for(var i=0;i<children.length;i++)parseNavPoint(children[i],(level||0)+1);
                }
                var topNavPoints=navMap.querySelectorAll(':scope > navPoint');
                for(var i=0;i<topNavPoints.length;i++)parseNavPoint(topNavPoints[i],0);
                return toc;
              }
              return null;
            }).catch(function(){return null});
          }
          /* ---- TOC (NAV) extraction for EPUB3 ---- */
          var navP=ncxP.then(function(toc){
            if(toc&&toc.length)return toc;
            var navItem=null;
            for(var mid in manifest){if(manifest[mid].props&&manifest[mid].props.indexOf('nav')>=0){navItem=manifest[mid];break}}
            if(!navItem)return null;
            var nf=zip.file(navItem.href);
            if(!nf)return null;
            return nf.async('text').then(function(navText){
              var navDoc=new DOMParser().parseFromString(navText,'application/xhtml+xml');
              var navEl=navDoc.querySelector('nav[type="toc"],nav[epub\\:type="toc"],nav[role="doc-toc"],nav#toc');
              if(!navEl)return null;
              var navDir=navItem.href.substring(0,navItem.href.lastIndexOf('/')+1);
              var toc2=[];
              function parseNavOl(ol,level){
                if(!ol)return;
                var items=ol.children;
                for(var i=0;i<items.length;i++){
                  var li=items[i];
                  if(li.tagName.toLowerCase()!=='li')continue;
                  var a=li.querySelector(':scope > a');
                  if(a){
                    var href=a.getAttribute('href')||'';
                    var title2=a.textContent.trim();
                    var hrefBase=href.split('#')[0];
                    var fullHref=hrefBase?resolvePath(navDir,hrefBase):'';
                    toc2.push({title:title2,href:fullHref+(href.indexOf('#')>=0?href.substring(href.indexOf('#')):''),level:level||0});
                  }
                  var subOl=li.querySelector(':scope > ol');
                  if(subOl)parseNavOl(subOl,(level||0)+1);
                }
              }
              var rootOl=navEl.querySelector(':scope > ol');
              parseNavOl(rootOl,0);
              return toc2.length?toc2:null;
            }).catch(function(){return null});
          });
          /* ---- CSS / Font extraction ---- */
          var cssItems=[],fontItems=[];
          for(var mid in manifest){
            var mi=manifest[mid];
            if(mi.type===CSS_TYPE)cssItems.push(mi);
            else if(FONT_TYPES.test(mi.type))fontItems.push(mi);
          }
          var fontP=Promise.all(fontItems.map(function(fi){
            var ff=zip.file(fi.href);if(!ff)return Promise.resolve(null);
            return ff.async('base64').then(function(b){return{href:fi.href,data:'data:'+fi.type+';base64,'+b}}).catch(function(){return null});
          })).then(function(arr){var m={};arr.forEach(function(f){if(f)m[f.href]=f.data});return m});
          var cssP=Promise.all(cssItems.map(function(ci){
            var cf=zip.file(ci.href);if(!cf)return Promise.resolve({href:ci.href,text:''});
            return cf.async('text').then(function(t){return{href:ci.href,text:t}}).catch(function(){return{href:ci.href,text:''}});
          })).then(function(arr){
            var cssMap={};arr.forEach(function(c){if(c.text)cssMap[c.href]=c.text});
            return{map:cssMap,raw:arr.map(function(c){return c.text}).join('\n')};
          });
          /* ---- Chapter extraction (batched for mobile Safari) ---- */
          var CH_BATCH=50;
          function extractChapter(ref){
            var item=manifest[ref];if(!item)return Promise.resolve({title:'',html:''});
            var f=zip.file(item.href);if(!f)return Promise.resolve({title:'',html:''});
            return f.async('text').then(function(xhtml){
              var xd=new DOMParser().parseFromString(xhtml,'application/xhtml+xml');
              var body=xd.querySelector('body');
              var h=body?body.querySelector('h1,h2,h3'):null;
              if(!h)h=xd.querySelector('h1,h2,h3');
              if(!h){var ht=xd.querySelector('title');if(ht&&ht.textContent.trim())h=ht}
              var chTitle=h?h.textContent.trim():'';
              var imgs=body?body.querySelectorAll('img'):[];
              var imgPs=[];
              imgs.forEach(function(img){
                var src=img.getAttribute('src');
                if(src&&!src.startsWith('data:')&&!src.startsWith('http')){
                  var imgPath=resolvePath(item.href,src);
                  var imgF=zip.file(imgPath);
                  if(imgF)imgPs.push(imgF.async('base64').then(function(b){
                    var ext2=src.split('.').pop().toLowerCase().split('?')[0];
                    var mt={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',svg:'image/svg+xml',webp:'image/webp'}[ext2]||'image/png';
                    img.setAttribute('src','data:'+mt+';base64,'+b);
                  }).catch(function(){img.remove()}));
                  else imgPs.push(Promise.resolve());
                }
              });
              return Promise.all(imgPs).then(function(){
                var html=body?body.innerHTML:'';
                var text=body?body.textContent.trim():'';
                return{title:chTitle,html:html,text:text,href:item.href};
              });
            }).catch(function(){return{title:'',html:'',text:''}});
          }
          function processBatch(startIdx){
            var result=[];
            var i=startIdx;
            function nextBatch(){
              var end=Math.min(i+CH_BATCH,spine.length);
              var batch=spine.slice(i,end);
              return Promise.all(batch.map(extractChapter)).then(function(r){
                result=result.concat(r);
                i=end;
                if(i<spine.length){return new Promise(function(resolve){setTimeout(resolve,0)}).then(nextBatch)}
                return result;
              });
            }
            return nextBatch();
          }
          var chP=processBatch(0);
          /* ---- Combine ---- */
          return Promise.all([coverP,chP,cssP,fontP,navP]).then(function(r){
            var cssData=r[2]||{map:{},raw:''};
            var epubCSS=processEpubCSS(cssData.raw||'',r[3]||{},cssData.map||{});
            return{title:title,cover:r[0],chapters:r[1],epubCSS:epubCSS,toc:r[4]};
          });
        });
      });
    }).then(function(result){cb(result)}).catch(function(e){cb(null,e.message||'EPUB 解析失败')});
  }catch(e){cb(null,e.message||'EPUB 解析失败')}
}
function processEpubCSS(rawCSS,fontMap,cssMap,depth){
  if(!rawCSS.trim())return'';
  if(!depth)depth=0;if(!cssMap)cssMap={};
  var css=rawCSS;
  /* resolve @import rules by inlining */
  if(depth<3){
    css=css.replace(/@import\s+(?:url\(\s*(['"]?)([^)'"]+)\1\s*\)|(['"])([^'"]+)\3)\s*;/g,function(q,qq1,uri1,qq2,uri2){
      var uri=(uri1||uri2||'').trim();if(!uri||uri.indexOf('://')>=0)return q;
      var inlined=cssMap[uri]||'';
      if(!inlined)for(var h in cssMap){if(h.endsWith('/'+uri)||uri.endsWith('/'+h)){inlined=cssMap[h];break}}
      return inlined?processEpubCSS(inlined,fontMap,cssMap,depth+1):'';
    });
  }
  /* resolve url() references to base64 data URIs */
  css=css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g,function(q,quote,uri){
    uri=uri.trim();if(!uri||uri.indexOf('data:')===0)return q;
    if(fontMap[uri])return'url('+quote+fontMap[uri]+quote+')';
    for(var h in fontMap){if(h.endsWith('/'+uri)||uri.endsWith('/'+h)||h===uri)return'url('+quote+fontMap[h]+quote+')'}
    return q;
  });
  /* scope all selectors under .epub-content */
  css=scopeCSS(css);
  return css;
}
function scopeCSS(css){
  var parts=[],i=0,len=css.length;
  while(i<len){
    while(i<len&&/\s/.test(css[i])){parts.push(css[i]);i++}
    if(i>=len)break;
    var ch=css[i];
    if(ch==='@'){
      var rest=css.substring(i,i+20);
      var atMatch=rest.match(/^@(charset|import|namespace|font-face|[-\w]*keyframes|media|supports|page)\b/i);
      if(atMatch){
        var atName=atMatch[1].toLowerCase();
        if(atName==='font-face'||atName.slice(-9)==='keyframes'){
          var atEnd=findBlockEnd(css,i);parts.push(css.substring(i,atEnd));i=atEnd;continue;
        }
        if(atName==='media'||atName==='supports'){
          var mOpen=css.indexOf('{',i);if(mOpen<0){parts.push(css.substring(i));break}
          parts.push(css.substring(i,mOpen+1));var inner=scopeCSS(css.substring(mOpen+1,findBlockEnd(css,mOpen+1)-1));parts.push(inner,'}');i=findBlockEnd(css,mOpen+1);continue;
        }
        if(atName==='import'){
          var semiI=css.indexOf(';',i);if(semiI<0){parts.push(css.substring(i));break}parts.push(css.substring(i,semiI+1));i=semiI+1;continue;
        }
        var semiJ=css.indexOf(';',i);if(semiJ<0){parts.push(css.substring(i));break}parts.push(css.substring(i,semiJ+1));i=semiJ+1;continue;
      }
    }
    var bStart=css.indexOf('{',i);
    if(bStart<0){parts.push(css.substring(i));break}
    var bEnd=css.indexOf('}',bStart);if(bEnd<0){parts.push(css.substring(i));break}
    var selectors=css.substring(i,bStart).trim();
    var body=css.substring(bStart,bEnd+1);
    if(selectors){
      var scoped=selectors.split(',').map(function(sel){
        sel=sel.trim();if(!sel)return sel;
        if(sel.indexOf('.epub-content')===0)return sel;
        return'.epub-content '+sel;
      }).join(', ');
      parts.push(scoped,' ',body);
    }else{parts.push(body)}
    i=bEnd+1;
  }
  return parts.join('');
}
function findBlockEnd(css,start){
  var depth=0,i=start,len=css.length;
  while(i<len){if(css[i]==='{')depth++;else if(css[i]==='}'){depth--;if(depth===0)return i+1}i++}
  return len;
}
function resolvePath(base,rel){
  try{rel=decodeURIComponent(rel)}catch(e){}
  var baseDir=base.substring(0,base.lastIndexOf('/')+1);
  if(rel.startsWith('/'))return rel.substring(1);
  var parts=(baseDir+rel).split('/'),stack=[];
  for(var i=0;i<parts.length;i++){if(parts[i]==='..')stack.pop();else if(parts[i]!==''&&parts[i]!=='.')stack.push(parts[i])}
  return stack.join('/');
}
/* 统一章节/目录路径比较：解码、去前导 ./、忽略大小写、允许尾缀匹配 */
function normHref(h){
  if(!h)return'';
  try{h=decodeURIComponent(h)}catch(e){}
  h=h.split('#')[0].replace(/^\.\//,'').replace(/\\/g,'/');
  while(h.charAt(0)==='/')h=h.slice(1);
  return h.toLowerCase();
}
function hrefMatch(a,b){
  a=normHref(a);b=normHref(b);
  if(!a||!b)return false;
  if(a===b)return true;
  if(a.endsWith('/'+b)||b.endsWith('/'+a))return true;
  /* 仅文件名一致时也算命中（部分 EPUB 目录与 spine 目录层级不同） */
  var ba=a.split('/').pop(),bb=b.split('/').pop();
  return ba&&bb&&ba===bb;
}
function findChapterByHref(href){
  if(!href)return -1;
  var base=href.split('#')[0];
  for(var i=0;i<S.chapters.length;i++){
    if(hrefMatch(S.chapters[i].href||'',base))return i;
  }
  return -1;
}

/* ===== Settings ===== */
function loadSettings(){try{var d=JSON.parse(localStorage.getItem('jd_s'));if(d){S.theme=d.theme||'light';S.fontSize=d.fs||18;S.lineHeight=d.lh||1.85;S.padding=d.pad||'normal';S.textColor=d.tc||''}}catch(e){}}
function saveSettings(){try{localStorage.setItem('jd_s',JSON.stringify({theme:S.theme,fs:S.fontSize,lh:S.lineHeight,pad:S.padding,tc:S.textColor||''}))}catch(e){}}
function loadPrivacyMode(){try{S.privacyMode=localStorage.getItem('jd_privacy')==='true'}catch(e){S.privacyMode=false}}
function savePrivacyMode(){try{localStorage.setItem('jd_privacy',S.privacyMode.toString())}catch(e){}}
function togglePrivacyMode(){S.privacyMode=!S.privacyMode;savePrivacyMode();updatePrivacyUI();renderBookshelf();toast(S.privacyMode?'已开启隐私模式':'已关闭隐私模式')}
function updatePrivacyUI(){var btn=$('privacy-toggle');if(btn){btn.textContent=S.privacyMode?'关闭':'开启';btn.classList.toggle('active',S.privacyMode)}updateReaderPrivacyBadge()}
function updateReaderPrivacyBadge(){if(!reader||!reader.classList.contains('active'))return;if(!tbTitle||!S.fileName)return;var title=S.fileName.replace(/\.[^.]+$/,'');tbTitle.innerHTML=S.privacyMode?'<span>'+esc(title)+'</span>':esc(title);tbTitle.classList.toggle('privacy-title',S.privacyMode)}
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
}

/* ===== Bookshelf UI ===== */
function renderBookshelf(){
  var lib=getLib(),grid=$('bs-grid'),empty=$('bs-empty');
  /* 普通与隐私书架是两个视图，私密书不会在普通模式中露出。 */
  var visibleLib=lib.filter(function(b){return!!b.pv===S.privacyMode});
  if(!visibleLib.length){grid.style.display='none';empty.style.display='flex';return}
  grid.style.display='grid';empty.style.display='none';
  visibleLib.sort(function(a,b){return(b.ts||0)-(a.ts||0)});
  var dirty=false;
  for(var di=0;di<visibleLib.length;di++){if(!visibleLib[di].cv){visibleLib[di].cv=generateCoverDataUrl(visibleLib[di].n);dirty=true}}
  if(dirty)saveLib(lib);
  grid.innerHTML=visibleLib.map(function(b,i){
    var title=b.n.replace(/\.[^.]+$/,'');
    var pct=getBookPct(b.n);
    var cv=b.cv;
    var dt=new Date(b.ts);var ds=(dt.getMonth()+1)+'/'+dt.getDate();
    var meta=fmtSize(b.s||0)+' · '+ds+(pct?' · '+pct+'%':'');
    var tpBadge=b.tp==='epub'?'EPUB':b.tp==='md'?'MD':'TXT';
    return '<div class="bs-card" data-name="'+esc(b.n)+'" style="animation-delay:'+i*.04+'s">' +
      '<div class="bs-card-cover"><img class="bs-card-img" src="'+cv+'" alt="" loading="lazy">' +
      '<div class="bs-card-pbar"><div class="bs-card-pfill" style="width:'+pct+'%"></div></div></div>' +
      '<div class="bs-card-info"><div class="bs-card-name" title="'+esc(b.n)+'">'+esc(title)+'</div>' +
      '<div class="bs-card-meta">'+meta+'</div></div>' +
      '<button class="bs-card-download" title="下载书籍"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg></button>' +
      '<button class="bs-card-del" title="删除"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>';
  }).join('');
}
function getBookPct(n){try{var p=JSON.parse(localStorage.getItem('jd_p')||'{}')[n];return p&&p.pct?p.pct:0}catch(e){return 0}}
function showBookshelf(){if(S.fileName){saveProg();stopReadingTimer();closeSearch();togglePanel('sidebar',false);togglePanel('settings',false)}clearEpubCSS();closeTip();reader.classList.remove('active');bookshelf.classList.remove('hide');renderBookshelf()}
function hideBookshelf(){bookshelf.classList.add('hide')}

/* ===== File Handling ===== */
function handleFile(f){
  if(!f)return;
  var ext=f.name.split('.').pop().toLowerCase();
  if(['txt','md','markdown','epub'].indexOf(ext)<0){toast('暂不支持此格式');return}
  if(ext==='epub'){handleEPUB(f);return}
  S.fileName=f.name;S.fileSize=f.size;S.fileType=(ext==='md'||ext==='markdown')?'md':'txt';
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
function finishEpubImport(name,size,result,source){
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
        addToLib(name,size,'epub',c);
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
  var sv=loadProg(S.fileName);var sc=sv?Math.min(sv.ch,S.chapters.length-1):0;var so=sv?sv.offset||0:0;
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
  dbLoad(name,function(data){
    if(!data){hideLoading();toast('书籍数据已失效，请重新导入');return}
    S.fileName=name;S.fileSize=data.size||0;S.fileType=data.type||'txt';
    _idbPersistReady=true;
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
  });
}
function deleteBook(name){
  var t=name.replace(/\.[^.]+$/,'');
  if(!confirm('确定要移除《'+t+'》？'))return;
  dbDelete(name,function(){});removeFromLib(name);
  try{var p=JSON.parse(localStorage.getItem('jd_p')||'{}');delete p[name];localStorage.setItem('jd_p',JSON.stringify(p))}catch(e){console.warn('清除进度失败',e)}
  try{localStorage.removeItem('jd_bm_'+name)}catch(e){console.warn('清除书签失败',e)}
  renderBookshelf();toast('已从书架移除');
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
  var sv=loadProg(S.fileName);var sc=sv?Math.min(sv.ch,S.chapters.length-1):0;var so=sv?sv.offset||0:0;
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
  d.appendChild(b);return d;
}
function createSep(){var d=document.createElement('div');d.className='ch-sep';d.innerHTML='<div class="ch-sep-dot"></div><div class="ch-sep-dot"></div><div class="ch-sep-dot"></div>';return d}
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
  contentEl.scrollTop=getContentOffset(bl)+(offset||0);
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
      scrollToChapter(chapter,offset||0);
      updateProgress();highlightToc();updateBmBtn();
      checkInfinite();schedulePreload();
      if(S.fileType==='epub'){processFootnotes();setupEpubLinkHandler()}
      releaseChapterBodies();
      if(typeof after==='function')after();
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
      if(S.fileType==='epub'&&_ftTipEl)_rebuildFtMap();
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
      if(S.fileType==='epub'&&_ftTipEl)_rebuildFtMap();
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
function updateReadingChapter(){var bs=contentInner.querySelectorAll('.ch-block');var cr=contentEl.getBoundingClientRect();var threshold=cr.top+contentEl.clientHeight*.33;var c=S.currentChapter;for(var i=0;i<bs.length;i++){var rect=bs[i].getBoundingClientRect();if(rect.top>threshold)break;c=+bs[i].dataset.idx}if(c!==S.currentChapter){S.currentChapter=c;highlightToc();updateBmBtn()}}
var svTimer;function afterScroll(){if(isAdjusting)return;closeTip();updateReadingChapter();updateProgress();checkInfinite();updateBmBtn();clearTimeout(svTimer);svTimer=setTimeout(function(){saveProg();schedulePreload()},SAVE_DELAY)}

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
function updateProgress(){var pct=getAccurateProgress(),pi=Math.round(pct*100);progressFill.style.width=pi+'%';progressThumb.style.left=pi+'%';progressTip.style.left=pi+'%';var ch=S.chapters[S.currentChapter];progressTip.textContent=(ch?ch.title:'')+' · '+pi+'%'}
function jumpToPercent(pct){var pd=getProgressData();if(!pd.total)return;var tc=pct*pd.total,ci=0;for(var i=0;i<pd.cum.length-1;i++){if(pd.cum[i+1]>=tc){ci=i;break}ci=i+1}ci=Math.min(ci,S.chapters.length-1);var cs=pd.cum[ci],cl=pd.cum[ci+1]-cs,cp2=cl>0?(tc-cs)/cl:0;var bl=contentInner.querySelector('[data-idx="'+ci+'"]');if(bl){contentEl.scrollTop=getContentOffset(bl)+cp2*bl.offsetHeight;if(ci!==S.currentChapter){S.currentChapter=ci;highlightToc();updateBmBtn()}}else{goToChapter(ci,function(){var b2=contentInner.querySelector('[data-idx="'+ci+'"]');if(b2)contentEl.scrollTop=getContentOffset(b2)+cp2*b2.offsetHeight})}}
function setupProgressDrag(){var dragging=false;function getPct(e){var r=progressTrack.getBoundingClientRect();var cx=e.touches?e.touches[0].clientX:e.clientX;return Math.max(0,Math.min(1,(cx-r.left)/r.width))}function visual(p){var pd=getProgressData(),pi=Math.round(p*100);progressFill.style.width=pi+'%';progressThumb.style.left=pi+'%';progressTip.style.left=pi+'%';var tc=p*pd.total,ci=0;for(var i=0;i<pd.cum.length-1;i++){if(pd.cum[i+1]>=tc){ci=i;break}ci=i+1}ci=Math.min(ci,S.chapters.length-1);progressTip.textContent=(S.chapters[ci]?S.chapters[ci].title:'')+' · '+pi+'%'}function start(e){if(!S.chapters.length)return;dragging=true;progressTrack.classList.add('active');visual(getPct(e))}function move(e){if(!dragging)return;visual(getPct(e));e.preventDefault()}function end(e){if(!dragging)return;dragging=false;progressTrack.classList.remove('active');var r=progressTrack.getBoundingClientRect();var cx=e.changedTouches?e.changedTouches[0].clientX:e.clientX;jumpToPercent(Math.max(0,Math.min(1,(cx-r.left)/r.width)))}on(progressTrack,'mousedown',start);on(document,'mousemove',move);on(document,'mouseup',end);on(progressTrack,'touchstart',function(e){e.preventDefault();start(e)},{passive:false});on(document,'touchmove',move,{passive:false});on(document,'touchend',end)}

/* ===== Bookmarks ===== */
function getBookmarks(){try{return JSON.parse(localStorage.getItem('jd_bm_'+S.fileName))||[]}catch(e){return[]}}
function saveBookmarks(bms){try{localStorage.setItem('jd_bm_'+S.fileName,JSON.stringify(bms))}catch(e){}}
function getFirstVisibleLine(){var els=contentInner.querySelectorAll('p, h2, h3, h4, li, blockquote, pre');var rect=contentEl.getBoundingClientRect();var vt=rect.top,vb=rect.bottom;var checked=0;for(var i=0;i<els.length;i++){var r=els[i].getBoundingClientRect();if(r.bottom<=vt||r.top>=vb)continue;checked++;if(checked>10)break;var text=els[i].textContent.trim();if(text)return text.slice(0,SNIP_MAX)}return''}
function toggleBookmark(){if(!S.fileName)return;var bms=getBookmarks();var exist=-1;for(var i=0;i<bms.length;i++){if(bms[i].ch===S.currentChapter&&Math.abs(bms[i].offset-getChapterOffset())<BM_OFFSET_TOL){exist=i;break}}if(exist>=0){bms.splice(exist,1);toast('已移除书签')}else{var firstLine=getFirstVisibleLine();if(!firstLine){toast('书签保存失败');return}var pct=Math.round(getAccurateProgress()*100);bms.push({ch:S.currentChapter,offset:getChapterOffset(),snip:firstLine,progress:pct,ts:Date.now()});toast('已添加书签')}saveBookmarks(bms);renderBookmarks();updateBmBtn()}
function getChapterOffset(){var bl=contentInner.querySelector('[data-idx="'+S.currentChapter+'"]');return bl?contentEl.scrollTop-getContentOffset(bl):0}
function deleteBookmark(i){var bms=getBookmarks();bms.splice(i,1);saveBookmarks(bms);renderBookmarks();updateBmBtn();toast('已删除书签')}
function renderBookmarks(){var bms=getBookmarks();if(!bms.length){bmList.innerHTML='<div class="bm-empty">暂无书签<br><small>阅读时点击书签图标添加</small></div>';return}bmList.innerHTML=bms.map(function(b,i){var cn=S.chapters[b.ch]?S.chapters[b.ch].title:'未知章节';var dt=new Date(b.ts);var ds=(dt.getMonth()+1)+'/'+dt.getDate()+' '+dt.getHours()+':'+String(dt.getMinutes()).padStart(2,'0');var prog=b.progress!==undefined?'<span class="bm-prog">'+b.progress+'</span>':'';return '<div class="bm-item" onclick="J.go('+b.ch+','+b.offset+')"><div class="bm-snippet">'+esc(b.snip||'')+'</div><div class="bm-meta"><span>'+cn+'</span><span>'+ds+'</span>'+prog+'</div><button class="bm-del" onclick="event.stopPropagation();J.delBm('+i+')" title="删除"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>'}).join('')}
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
  var q=searchInput.value.trim();
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
      var t=getChText(S.chapters[i],i);
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
function clearHighlights(){contentInner.querySelectorAll('mark.shl').forEach(function(m){m.replaceWith(document.createTextNode(m.textContent))});contentInner.normalize()}
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
    html.push('<div class="'+cls+'" data-vi="'+i+'" style="top:'+(i*_tocItemH)+'px;height:'+_tocItemH+'px">'+esc(row.title||'')+'</div>');
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
function saveProg(){try{var a=JSON.parse(localStorage.getItem('jd_p')||'{}');var pct=0;try{pct=Math.round(getAccurateProgress()*100)}catch(e){}a[S.fileName]={ch:S.currentChapter,offset:getChapterOffset(),pct:pct,ts:Date.now()};localStorage.setItem('jd_p',JSON.stringify(a))}catch(e){}}
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
  on($('privacy-toggle'),'click',togglePrivacyMode);
  on($('cache-clear'),'click',clearCache);
  updateCacheStats();
}

/* ===== WebDAV ===== */
function loadWebDAVCredentials(){
  try{
    var saved=JSON.parse(localStorage.getItem('jd_webdav')||'null');
    if(saved){
      webdavCredentials=saved;
      if(saved.url)webdavUrlInput.value=saved.url;
      if(saved.username)webdavUsernameInput.value=saved.username;
      if(saved.password)webdavPasswordInput.value=saved.password;
      if(saved.remember!==undefined)webdavRememberCheckbox.checked=saved.remember;
    }
  }catch(e){}
}
function saveWebDAVCredentials(){
  if(webdavRememberCheckbox.checked){
    webdavCredentials={
      url:webdavUrlInput.value.trim(),
      username:webdavUsernameInput.value,
      password:webdavPasswordInput.value,
      remember:true
    };
  }else{
    webdavCredentials={url:webdavUrlInput.value.trim(),username:'',password:'',remember:false};
  }
  try{localStorage.setItem('jd_webdav',JSON.stringify(webdavCredentials))}catch(e){}
}
function showWebDAVModal(){
  loadWebDAVCredentials();
  webdavStepUrl.style.display='';
  webdavStepAuth.style.display='none';
  webdavStepBrowse.style.display='none';
  webdavModalTitle.textContent='远程上传';
  webdavModal.classList.add('show');
}
function hideWebDAVModal(){webdavModal.classList.remove('show')}
function webdavMakeAuth(username,password){return'Basic '+btoa(unescape(encodeURIComponent(username+':'+password)))}
function webdavBuildHeaders(){
  var headers={'Authorization':webdavAuth};
  return headers;
}
function webdavFetch(path,options){
  var url=webdavBaseUrl.replace(/\/$/,'')+'/'+path.replace(/^\//,'');
  options=options||{};
  options.headers=Object.assign({},options.headers||{},webdavBuildHeaders());
  return fetch(url,options);
}
function webdavPropfind(path,depth){
  depth=depth||'1';
  var body='<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>';
  return webdavFetch(path,{
    method:'PROPFIND',
    headers:Object.assign({'Content-Type':'application/xml','Depth':depth},webdavBuildHeaders()),
    body:body
  });
}
function webdavParseResponse(xml){
  var parser=new DOMParser();
  var doc=parser.parseFromString(xml,'application/xml');
  var responses=doc.querySelectorAll('response');
  var items=[];
  for(var i=0;i<responses.length;i++){
    var resp=responses[i];
    var href=resp.querySelector('href');
    if(!href)continue;
    var hrefText=decodeURIComponent(href.textContent);
    var propstat=resp.querySelector('propstat');
    if(!propstat)continue;
    var prop=propstat.querySelector('prop');
    if(!prop)continue;
    var resourcetype=prop.querySelector('resourcetype');
    var isFolder=resourcetype?resourcetype.querySelector('collection')!==null:false;
    var getcontentlength=prop.querySelector('getcontentlength');
    var size=getcontentlength?parseInt(getcontentlength.textContent)||0:0;
    var getlastmodified=prop.querySelector('getlastmodified');
    var modified=getlastmodified?getlastmodified.textContent:'';
    items.push({href:hrefText,name:hrefText.split('/').filter(Boolean).pop(),isFolder:isFolder,size:size,modified:modified});
  }
  return items;
}
function webdavIsSupported(ext){
  if(!ext)return false;
  ext=ext.toLowerCase();
  return['txt','md','markdown','epub'].indexOf(ext)>=0;
}
function webdavGetExt(filename){return filename.split('.').pop().toLowerCase()}
function webdavListDir(path){
  webdavCurrentPath=path||'/';
  webdavFileList.innerHTML='<div class="webdav-loading">加载中...</div>';
  webdavBreadcrumb.innerHTML='';
  renderBreadcrumb();
  webdavPropfind(path,'1').then(function(resp){
    if(!resp.ok){
      if(resp.status===401){
        showWebDAVStep('auth');
        toast('认证失败，请输入用户名密码');
        return;
      }
      throw new Error('请求失败: '+resp.status);
    }
    return resp.text();
  }).then(function(xml){
    if(!xml)return;
    var items=webdavParseResponse(xml);
    var currentItems=items.filter(function(item){
      if(item.href===path||item.href===path.replace(/\/$/,'')||item.href===(path.endsWith('/')?path.slice(0,-1):path+'/'))return false;
      var itemPath=item.href.replace(webdavBaseUrl.replace(/https?:\/\/[^\/]+/,''),'');
      var currentPathClean=path.replace(/\/$/,'');
      return itemPath.startsWith(currentPathClean+'/')&&!itemPath.slice(currentPathClean.length+1).includes('/');
    });
    currentItems.sort(function(a,b){
      if(a.isFolder!==b.isFolder)return a.isFolder?-1:1;
      return a.name.localeCompare(b.name);
    });
    renderFileList(currentItems);
  }).catch(function(err){
    webdavFileList.innerHTML='<div class="webdav-empty">加载失败: '+err.message+'</div>';
  });
}
function renderBreadcrumb(){
  webdavBreadcrumb.innerHTML='';
  var parts=webdavCurrentPath.split('/').filter(Boolean);
  var homeItem=document.createElement('span');
  homeItem.className='webdav-breadcrumb-item'+(parts.length===0?' current':'');
  homeItem.textContent='根目录';
  homeItem.onclick=function(){if(parts.length>0)webdavListDir('/')};
  webdavBreadcrumb.appendChild(homeItem);
  var path='';
  for(var i=0;i<parts.length;i++){
    path+='/'+parts[i];
    var sep=document.createElement('span');
    sep.textContent='›';
    sep.style.color='var(--text-sec)';
    webdavBreadcrumb.appendChild(sep);
    var item=document.createElement('span');
    item.className='webdav-breadcrumb-item'+(i===parts.length-1?' current':'');
    item.textContent=parts[i];
    (function(p){item.onclick=function(){webdavListDir(p)}})(path);
    webdavBreadcrumb.appendChild(item);
  }
}
function renderFileList(items){
  if(!items.length){
    webdavFileList.innerHTML='<div class="webdav-empty">此目录为空</div>';
    return;
  }
  webdavFileList.innerHTML='';
  items.forEach(function(item){
    var div=document.createElement('div');
    div.className='webdav-file-item';
    if(item.isFolder)div.classList.add('folder');
    var icon=document.createElement('div');
    icon.className='webdav-file-icon'+(item.isFolder?' folder':'');
    icon.innerHTML=item.isFolder?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>';
    var name=document.createElement('div');
    name.className='webdav-file-name';
    name.textContent=item.name;
    var size=document.createElement('div');
    size.className='webdav-file-size';
    if(item.isFolder){
      size.textContent='文件夹';
    }else{
      size.textContent=fmtSize(item.size);
    }
    div.appendChild(icon);
    div.appendChild(name);
    div.appendChild(size);
    if(item.isFolder){
      div.onclick=function(){webdavListDir(item.href.replace(webdavBaseUrl.replace(/https?:\/\/[^\/]+/,''),''))};
    }else{
      var ext=webdavGetExt(item.name);
      if(webdavIsSupported(ext)){
        div.onclick=function(){webdavDownloadFile(item)};
      }else{
        div.style.opacity='.5';
        div.style.cursor='not-allowed';
        size.textContent='不支持的格式';
      }
    }
    webdavFileList.appendChild(div);
  });
}
function webdavDownloadFile(item){
  hideWebDAVModal();
  showLoading('正在下载 '+item.name+'...');
  var path=item.href.replace(webdavBaseUrl.replace(/https?:\/\/[^\/]+/,''),'');
  webdavFetch(path).then(function(resp){
    if(!resp.ok)throw new Error('下载失败: '+resp.status);
    return resp.arrayBuffer();
  }).then(function(buf){
    var ext=webdavGetExt(item.name);
    var fileType=(ext==='md'||ext==='markdown')?'md':ext;
    var source=new Blob([buf],{type:ext==='epub'?'application/epub+zip':'text/plain'});
    S.fileName=item.name;
    S.fileSize=item.size;
    S.fileType=fileType;
    showLoading('正在解析内容...');
    setTimeout(function(){
      try{
        if(ext==='epub'){
          parseEPUB(buf,function(result,err){
            if(err||!result){hideLoading();toast('EPUB 解析失败: '+(err||'未知错误'));return}
            finishEpubImport(item.name,item.size,result,source);
          });
        }else{
          S.rawText=decodeBuffer(buf);
          var cv=generateCoverDataUrl(item.name);
          dbSave(S.fileName,{text:S.rawText,type:S.fileType,size:S.fileSize,cover:cv},function(){addToLib(S.fileName,S.fileSize,S.fileType,cv)});
          processContent();
        }
      }catch(err){console.error(err);toast('文件解析失败: '+err.message);hideLoading()}
    },PROC_DELAY);
  }).catch(function(err){
    hideLoading();
    toast('下载失败: '+err.message);
  });
}
function showWebDAVStep(step){
  webdavStepUrl.style.display='none';
  webdavStepAuth.style.display='none';
  webdavStepBrowse.style.display='none';
  if(step==='url'){
    webdavStepUrl.style.display='';
    webdavModalTitle.textContent='远程上传';
  }else if(step==='auth'){
    webdavStepAuth.style.display='';
    webdavModalTitle.textContent='账号验证';
  }else if(step==='browse'){
    webdavStepBrowse.style.display='';
    webdavModalTitle.textContent='WebDAV - '+webdavUrlInput.value.trim();
  }
}
function webdavConnect(){
  var url=webdavUrlInput.value.trim();
  if(!url){toast('请输入服务器地址');return}
  if(!url.match(/^https?:\/\//)){url='http://'+url;webdavUrlInput.value=url}
  var urlObj=new URL(url);
  var basePath=urlObj.pathname.replace(/\/$/,'')||'/';
  webdavBaseUrl=urlObj.origin;
  webdavCurrentPath=basePath;
  saveWebDAVCredentials();
  showLoading('正在连接...');
  webdavPropfind(basePath,'0').then(function(resp){
    hideLoading();
    if(resp.status===401){
      if(webdavCredentials.username&&webdavCredentials.password){
        webdavAuth=webdavMakeAuth(webdavCredentials.username,webdavCredentials.password);
        webdavTestAuth();
      }else{
        showWebDAVStep('auth');
      }
      return;
    }
    if(!resp.ok)throw new Error('连接失败: '+resp.status);
    showWebDAVStep('browse');
    webdavListDir(basePath);
  }).catch(function(err){
    hideLoading();
    toast('无法连接到服务器，请检查地址是否正确');
  });
}
function webdavTestAuth(){
  showLoading('正在验证...');
  webdavPropfind(webdavCurrentPath,'0').then(function(resp){
    hideLoading();
    if(resp.status===401){
      toast('账号或密码错误');
      showWebDAVStep('auth');
      return;
    }
    if(!resp.ok)throw new Error('验证失败: '+resp.status);
    saveWebDAVCredentials();
    showWebDAVStep('browse');
    webdavListDir(webdavCurrentPath);
  }).catch(function(err){
    hideLoading();
    toast('验证失败: '+err.message);
    showWebDAVStep('auth');
  });
}
function webdavLogin(){
  var username=webdavUsernameInput.value;
  var password=webdavPasswordInput.value;
  if(!username){toast('请输入用户名');return}
  webdavAuth=webdavMakeAuth(username,password);
  showLoading('正在验证...');
  webdavPropfind(webdavCurrentPath,'0').then(function(resp){
    hideLoading();
    if(resp.status===401){
      toast('账号或密码错误');
      return;
    }
    if(!resp.ok)throw new Error('验证失败: '+resp.status);
    saveWebDAVCredentials();
    showWebDAVStep('browse');
    webdavListDir(webdavCurrentPath);
  }).catch(function(err){
    hideLoading();
    toast('验证失败: '+err.message);
  });
}
function setupEvents(){
  on($('bs-main'),'click',function(e){var c=e.target.closest('.bs-card');if(!c)return;var n=c.dataset.name;if(!n)return;if(e.target.closest('.bs-card-del')){deleteBook(n)}else if(e.target.closest('.bs-card-download')){downloadBook(n)}else{loadBookFromShelf(n)}});
  on($('bs-import'),'click',function(e){
    e.stopPropagation();
    importDropdownMenu.classList.toggle('show');
  });
  on($('import-local'),'click',function(e){
    e.stopPropagation();
    importDropdownMenu.classList.remove('show');
    fileInput.click();
  });
  on(fileInput,'change',function(){var f=fileInput.files[0];if(f)handleFile(f);fileInput.value=''});
  on($('import-webdav'),'click',function(e){
    e.stopPropagation();
    importDropdownMenu.classList.remove('show');
    showWebDAVModal();
  });
  on(document,'mousedown',function(e){
    if(!e.target.closest('.import-dropdown')){
      importDropdownMenu.classList.remove('show');
    }
  });
  on(document,'mousedown',function(e){
    if(webdavModal.classList.contains('show')&&!e.target.closest('.webdav-modal-content')){
      hideWebDAVModal();
    }
  });
  on($('webdav-modal-close'),'click',hideWebDAVModal);
  on($('webdav-connect'),'click',webdavConnect);
  on($('webdav-login'),'click',webdavLogin);
  on($('webdav-auth-back'),'click',function(){
    showWebDAVStep('url');
    webdavModalTitle.textContent='远程上传';
  });
  on($('webdav-refresh'),'click',function(){webdavListDir(webdavCurrentPath)});
  on($('webdav-back'),'click',function(){
    var parts=webdavCurrentPath.split('/').filter(Boolean);
    if(parts.length>1){
      parts.pop();
      webdavListDir('/'+parts.join('/')+'/');
    }else{
      webdavListDir('/');
    }
  });
  on($('bs-theme-btn'),'click',toggleTheme);
  on($('bs-settings-btn'),'click',function(){showBookshelfSettings()});
  on(document,'dragover',function(e){e.preventDefault()});
  on(document,'drop',function(e){e.preventDefault();if(e.dataTransfer&&e.dataTransfer.files[0])handleFile(e.dataTransfer.files[0])});
  on(contentEl,'click',function(e){if(_touchTap){_touchTap=false;return}if(toolbar.classList.contains('visible')){toolbar.classList.remove('visible');progressTrack.classList.remove('active');syncSearchBar()}else{var r=contentEl.getBoundingClientRect();if(e.clientY-r.top<r.height*.5){toolbar.classList.add('visible');progressTrack.classList.add('active');syncSearchBar();updateToolbarTime()}}});
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
  document.querySelectorAll('.stab').forEach(function(b){on(b,'click',function(){document.querySelectorAll('.stab').forEach(function(x){x.classList.remove('active')});document.querySelectorAll('.stab-panel').forEach(function(x){x.classList.remove('active')});b.classList.add('active');var p=$(b.dataset.tab==='toc'?'toc-panel':'bm-panel');if(p)p.classList.add('active')})});
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
  on(document,'keydown',function(e){if(e.key==='Escape')closeAllPanels();if((e.ctrlKey||e.metaKey)&&e.key==='f'){e.preventDefault();openSearch()}});
  on(document,'click',function(e){var tip=document.querySelector('.ft-tip.show');if(tip&&!tip.contains(e.target)&&!e.target.closest('a[epub\\:type="noteref"]')){closeTip()}});
}
function togglePanel(n,force){if(n==='sidebar'){var o=force!==undefined?force:!sidebar.classList.contains('open');sidebar.classList.toggle('open',o);sidebarOverlay.classList.toggle('show',o);var sw=o?sidebar.offsetWidth+'px':'';toolbar.style.left=sw;searchBar.style.left=sw;if(o)highlightToc()}else{var o2=force!==undefined?force:!settingsEl.classList.contains('open');settingsEl.classList.toggle('open',o2);settingsOverlay.classList.toggle('show',o2);if(o2){updateStatsDisplay();updateCacheStats()}}}
function showBookshelfSettings(){settingsEl.classList.add('open');settingsOverlay.classList.add('show');updateStatsDisplay();updateCacheStats()}

/* ===== Helpers ===== */
function showLoading(m){if(loading){loading.classList.add('show');if(loadingText)loadingText.textContent=m||'加载中...'}}
function hideLoading(){if(loading)loading.classList.remove('show')}
function showReader(){hideBookshelf();buildTOC();if(reader)reader.classList.add('active');updateReaderPrivacyBadge();var bm=$('btn-bm');if(bm){bm.classList.remove('on');var sv=bm.querySelector('svg');if(sv)sv.setAttribute('fill','none')}requestAnimationFrame(function(){hideLoading()});startReadingTimer()}
function fmtSize(b){return b<1024?b+'B':b<1048576?(b/1024).toFixed(1)+'KB':(b/1048576).toFixed(1)+'MB'}
function toast(msg){if(!toastEl)return;toastEl.textContent=msg;toastEl.classList.add('show');clearTimeout(toastEl._t);toastEl._t=setTimeout(function(){toastEl.classList.remove('show')},TOAST_MS)}
function debounce(fn,ms){var t;return function(){var a=arguments,c=this;clearTimeout(t);t=setTimeout(function(){fn.apply(c,a)},ms)}}
function getStats(){try{return JSON.parse(localStorage.getItem('jd_stats')||'{"totalMin":0,"todayMin":0,"date":"","sessions":0,"books":{}}')}catch(e){return{totalMin:0,todayMin:0,date:'',sessions:0,books:{}}}}
function saveStats(s){try{localStorage.setItem('jd_stats',JSON.stringify(s))}catch(e){}}
function updateStatsDisplay(){var s=getStats(),b=s.books[S.fileName];$('stats-total').textContent=s.totalMin+' 分钟';$('stats-today').textContent=s.todayMin+' 分钟';$('stats-book').textContent=(b?b.min:0)+' 分钟'}
function tickReading(){if(!_rs)return;var now=Date.now(),elapsed=Math.floor((now-_rs)/60000);if(elapsed<1)return;var s=getStats(),today=new Date().toISOString().slice(0,10);if(s.date!==today){s.todayMin=0;s.date=today}s.totalMin+=elapsed;s.todayMin+=elapsed;if(S.fileName){if(!s.books[S.fileName])s.books[S.fileName]={min:0,opens:0};s.books[S.fileName].min+=elapsed}saveStats(s);_rs=now;updateStatsDisplay()}
function updateToolbarTime(){}
function startReadingTimer(){stopReadingTimer();_rs=Date.now();_rt=setInterval(tickReading,60000);_rtSec=setInterval(updateToolbarTime,10000);var s=getStats();s.sessions++;saveStats(s);updateStatsDisplay();updateToolbarTime()}
function stopReadingTimer(){if(_rt){clearInterval(_rt);_rt=null}if(_rtSec){clearInterval(_rtSec);_rtSec=null}tickReading();_rs=0;updateToolbarTime()}
function updateCacheStats(){var l=getLib().filter(function(b){return!!b.pv===S.privacyMode}),t=0;for(var i=0;i<l.length;i++)t+=l[i].s||0;$('cache-info').textContent='缓存 '+l.length+' 本书，占用 '+fmtSize(t)}
function clearBookStorage(){
  /* 仅清书籍相关 localStorage：书架、进度、书签；不动设置/隐私/统计/WebDAV */
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
  if(!confirm('确定清除所有书籍缓存？进度与书签也会删除，需要重新导入才能阅读。'))return;
  dbClearAll(function(ok){
    if(!ok){toast('数据库不可用');return}
    clearBookStorage();
    /* 若正在阅读，退回书架并清空内存中的书籍数据 */
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
    S.fileName='';S.fileSize=0;S.fileType='';S.rawText='';
    S.chapters=[];S.currentChapter=0;S.epubCSS='';S.epubTitle='';S.toc=null;
    S.storeMode='inline';S.searchQuery='';S.searchResults=[];S.searchIdx=-1;
    firstLoaded=-1;lastLoaded=-1;_progData=null;_textCache=null;_textCacheLen=0;_tocItems=[];
    if(contentInner)contentInner.innerHTML='';
    renderBookshelf();updateCacheStats();toast('缓存已清除');
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
  _ftMap={};
  var allAsides=contentInner.querySelectorAll('aside');
  allAsides.forEach(function(aside){
    if(aside.getAttribute('epub:type')==='footnote'){
      var id=aside.getAttribute('id');
      if(id){var li=aside.querySelector('.duokan-footnote-item,li');_ftMap[id]=li?li.textContent.trim():aside.textContent.trim();aside.classList.add('footnote-hidden')}
    }
  });
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
function _rebuildFtMap(){
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
  goToHeading:function(chIdx,hIdx){
    goToChapter(chIdx,function(){
      var el=contentInner.querySelector('[id="ch-'+chIdx+'-h-'+hIdx+'"]');
      if(el)scrollToElement(el,60);
    });
  }
};

})();
