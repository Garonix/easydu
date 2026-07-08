(function(){
'use strict';

var S={fileName:'',fileSize:0,fileType:'',rawText:'',chapters:[],currentChapter:0,theme:'light',fontSize:18,lineHeight:1.85,padding:'normal',searchQuery:'',searchResults:[],searchIdx:-1};
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
var firstLoaded=-1,lastLoaded=-1,isAdjusting=false,_progData=null,_rs=0,_rt=null;
var coverHues=[25,42,120,175,210,260,330,15,55,150,200,280,350,80,300,10];
var CH_HEADING_GAP=10,BM_OFFSET_TOL=200,SCROLL_BOUND=800,PARA_MAX=4000,SAVE_DELAY=800,PROC_DELAY=30,TB_HIDE_MS=2500,TOAST_MS=1800,SEARCH_DELAY=200,SWIPE_MIN=60,SNIP_MAX=100,TRIM_WIN=3;

function on(el,ev,fn,opt){if(el)el.addEventListener(ev,fn,opt||false)}
loadSettings();applySettings();setupEvents();setupProgressDrag();renderBookshelf();

/* ===== IndexedDB ===== */
var DBN='JingDuV2',DBV=1,STORE='books';
function openDB(cb){if(!window.indexedDB){cb(null);return}var r=indexedDB.open(DBN,DBV);r.onupgradeneeded=function(e){var d=e.target.result;if(!d.objectStoreNames.contains(STORE))d.createObjectStore(STORE,{keyPath:'name'})};r.onsuccess=function(e){cb(e.target.result)};r.onerror=function(){cb(null)}}
function dbSave(name,data,cb){openDB(function(db){if(!db){cb&&cb(false);return}var tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put({name:name,text:data.text||'',chapters:data.chapters||null,type:data.type,size:data.size,cover:data.cover||null});tx.oncomplete=function(){cb&&cb(true)};tx.onerror=function(){cb&&cb(false)}})}
function dbLoad(name,cb){openDB(function(db){if(!db){cb(null);return}var tx=db.transaction(STORE,'readonly'),r=tx.objectStore(STORE).get(name);r.onsuccess=function(){cb(r.result||null)};r.onerror=function(){cb(null)}})}
function dbDelete(name,cb){openDB(function(db){if(!db){cb&&cb();return}var tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(name);tx.oncomplete=function(){cb&&cb()}})}

/* ===== Library ===== */
function getLib(){try{return JSON.parse(localStorage.getItem('jd_lib'))||[]}catch(e){return[]}}
function saveLib(l){try{localStorage.setItem('jd_lib',JSON.stringify(l))}catch(e){}}
function addToLib(n,s,tp,cv){var l=getLib().filter(function(b){return b.n!==n});l.unshift({n:n,s:s,tp:tp,ts:Date.now(),cv:cv||null});saveLib(l)}
function removeFromLib(n){saveLib(getLib().filter(function(b){return b.n!==n}))}
function touchLib(n){var l=getLib();for(var i=0;i<l.length;i++){if(l[i].n===n){l[i].ts=Date.now();break}}saveLib(l)}

/* ===== Cover Generation (Canvas) ===== */
function generateCoverDataUrl(name){
  try{
    var c=document.createElement('canvas');c.width=160;c.height=224;var ctx=c.getContext('2d');
    var title=name.replace(/\.[^.]+$/,'');
    var h=0;for(var i=0;i<name.length;i++)h=name.charCodeAt(i)+((h<<5)-h);
    var hue=coverHues[Math.abs(h)%coverHues.length];
    var g=ctx.createLinearGradient(0,0,160,224);
    g.addColorStop(0,'hsl('+hue+',28%,32%)');g.addColorStop(1,'hsl('+(hue+25)%360+',32%,22%)');
    ctx.fillStyle=g;ctx.fillRect(0,0,160,224);
    ctx.fillStyle='rgba(255,255,255,.025)';for(var y=0;y<224;y+=3)ctx.fillRect(0,y,160,1);
    ctx.strokeStyle='rgba(255,255,255,.1)';ctx.lineWidth=1;ctx.strokeRect(12,12,136,200);
    ctx.fillStyle='rgba(255,255,255,.88)';ctx.textAlign='center';ctx.textBaseline='middle';
    var fs=title.length<=4?28:title.length<=8?22:title.length<=14?17:13;
    ctx.font='bold '+fs+'px "LXGW WenKai",serif';
    var lines=[],line='';
    for(var j=0;j<title.length;j++){var t=line+title[j];if(ctx.measureText(t).width>120){lines.push(line);line=title[j]}else line=t}
    if(line)lines.push(line);
    var startY=112-(lines.length*(fs+6))/2;
    for(var k=0;k<Math.min(lines.length,6);k++)ctx.fillText(lines[k],80,startY+k*(fs+6));
    var sepY=startY+Math.min(lines.length,6)*(fs+6)+14;
    ctx.strokeStyle='rgba(255,255,255,.18)';ctx.beginPath();ctx.moveTo(50,sepY);ctx.lineTo(110,sepY);ctx.stroke();
    var ext=name.split('.').pop().toUpperCase();
    ctx.font='9px sans-serif';ctx.fillStyle='rgba(255,255,255,.3)';ctx.fillText(ext,80,200);
    return c.toDataURL('image/jpeg',.72);
  }catch(e){return''}
}

/* ===== EPUB Parser ===== */
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
          var chP=Promise.all(spine.map(function(ref){
            var item=manifest[ref];if(!item)return Promise.resolve({title:'',html:''});
            var f=zip.file(item.href);if(!f)return Promise.resolve({title:'',html:''});
            return f.async('text').then(function(xhtml){
              var xd=new DOMParser().parseFromString(xhtml,'application/xhtml+xml');
              var body=xd.querySelector('body');
              var h=xd.querySelector('h1,h2,h3,title');
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
                return{title:chTitle,html:html,text:text};
              });
            }).catch(function(){return{title:'',html:'',text:''}});
          }));
          return Promise.all([coverP,chP]).then(function(r){return{title:title,cover:r[0],chapters:r[1]}});
        });
      });
    }).then(function(result){cb(result)}).catch(function(e){cb(null,e.message||'EPUB 解析失败')});
  }catch(e){cb(null,e.message||'EPUB 解析失败')}
}
function resolvePath(base,rel){
  var baseDir=base.substring(0,base.lastIndexOf('/')+1);
  if(rel.startsWith('/'))return rel.substring(1);
  var parts=(baseDir+rel).split('/'),stack=[];
  for(var i=0;i<parts.length;i++){if(parts[i]==='..')stack.pop();else if(parts[i]!==''&&parts[i]!=='.')stack.push(parts[i])}
  return stack.join('/');
}

/* ===== Settings ===== */
function loadSettings(){try{var d=JSON.parse(localStorage.getItem('jd_s'));if(d){S.theme=d.theme||'light';S.fontSize=d.fs||18;S.lineHeight=d.lh||1.85;S.padding=d.pad||'normal'}}catch(e){}}
function saveSettings(){try{localStorage.setItem('jd_s',JSON.stringify({theme:S.theme,fs:S.fontSize,lh:S.lineHeight,pad:S.padding}))}catch(e){}}
function applySettings(){
  document.documentElement.setAttribute('data-theme',S.theme);
  if(contentInner){contentInner.style.fontSize=S.fontSize+'px';contentInner.style.lineHeight=S.lineHeight;contentInner.style.padding=({narrow:'40px 16px 100px',normal:'60px 24px 100px',wide:'80px 48px 100px'})[S.padding]||'60px 24px 100px'}
  var rf=$('range-fs'),vf=$('val-fs'),rl=$('range-lh'),vl=$('val-lh');
  if(rf)rf.value=S.fontSize;if(vf)vf.textContent=S.fontSize+'px';
  if(rl)rl.value=S.lineHeight;if(vl)vl.textContent=S.lineHeight.toFixed(2);
  document.querySelectorAll('.theme-toggle button').forEach(function(b){b.classList.toggle('active',b.dataset.t===S.theme)});
  document.querySelectorAll('[data-pad]').forEach(function(b){b.classList.toggle('active',b.dataset.pad===S.padding)});
}

/* ===== Bookshelf UI ===== */
function renderBookshelf(){
  var lib=getLib(),grid=$('bs-grid'),empty=$('bs-empty');
  if(!lib.length){grid.style.display='none';empty.style.display='flex';return}
  grid.style.display='grid';empty.style.display='none';
  lib.sort(function(a,b){return(b.ts||0)-(a.ts||0)});
  var dirty=false;
  for(var di=0;di<lib.length;di++){if(!lib[di].cv){lib[di].cv=generateCoverDataUrl(lib[di].n);dirty=true}}
  if(dirty)saveLib(lib);
  grid.innerHTML=lib.map(function(b,i){
    var title=b.n.replace(/\.[^.]+$/,'');
    var pct=getBookPct(b.n);
    var cv=b.cv;
    var dt=new Date(b.ts);var ds=(dt.getMonth()+1)+'/'+dt.getDate();
    var meta=fmtSize(b.s||0)+' · '+ds+(pct?' · '+pct+'%':'');
    var tpBadge=b.tp==='epub'?'EPUB':b.tp==='md'?'MD':'TXT';
    return '<div class="bs-card" style="animation-delay:'+i*.04+'s" onclick="J.openBook('+q(b.n)+')">' +
      '<div class="bs-card-cover"><img class="bs-card-img" src="'+cv+'" alt="" loading="lazy">' +
      '<div class="bs-card-pbar"><div class="bs-card-pfill" style="width:'+pct+'%"></div></div></div>' +
      '<div class="bs-card-info"><div class="bs-card-name" title="'+esc(b.n)+'">'+esc(title)+'</div>' +
      '<div class="bs-card-meta">'+meta+'</div></div>' +
      '<button class="bs-card-del" onclick="event.stopPropagation();J.delBook('+q(b.n)+')" title="删除"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>';
  }).join('');
}
function getBookPct(n){try{var p=JSON.parse(localStorage.getItem('jd_p')||'{}')[n];return p&&p.pct?p.pct:0}catch(e){return 0}}
function showBookshelf(){if(S.fileName){saveProg();stopReadingTimer();closeSearch();togglePanel('sidebar',false);togglePanel('settings',false)}reader.classList.remove('active');bookshelf.classList.remove('hide');renderBookshelf()}
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
      S.rawText='';
      S.chapters=result.chapters.map(function(ch){return{title:ch.title||'',content:ch.text||'',html:ch.html||''}});
      var cv=result.cover||generateCoverDataUrl(f.name);
      if(cv&&cv.indexOf('data:image')===0&&cv.length>5000){
        resizeCover(cv,160,224,function(small){
          var finalCv=small||cv;
          dbSave(f.name,{chapters:result.chapters,type:'epub',size:f.size,cover:finalCv},function(){addToLib(f.name,f.size,'epub',finalCv)});
          afterParseEPUB();
        });
      }else{
        dbSave(f.name,{chapters:result.chapters,type:'epub',size:f.size,cover:cv},function(){addToLib(f.name,f.size,'epub',cv)});
        afterParseEPUB();
      }
    });
  };
  rd.readAsArrayBuffer(f);
}
function afterParseEPUB(){
  _progData=null;
  if(!S.chapters||!S.chapters.length)S.chapters=[{title:'全文',content:S.rawText||'(空文件)',html:''}];
  var sv=loadProg(S.fileName);var sc=sv?Math.min(sv.ch,S.chapters.length-1):0;var so=sv?sv.offset||0:0;
  S.searchQuery='';S.searchResults=[];S.searchIdx=-1;
  renderBookmarks();showReader();initSeamless(sc,so);
}
function resizeCover(dataUrl,mw,mh,cb){
  var img=new Image();
  img.onload=function(){
    var c=document.createElement('canvas');
    var r=Math.min(mw/img.width,mh/img.height);
    c.width=Math.round(img.width*r);c.height=Math.round(img.height*r);
    c.getContext('2d').drawImage(img,0,0,c.width,c.height);
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
    if(data.type==='epub'&&data.chapters){
      S.rawText='';
      S.chapters=data.chapters.map(function(ch){return{title:ch.title||'',content:ch.text||'',html:ch.html||''}});
      touchLib(name);afterParseEPUB();
    }else{
      S.rawText=data.text||'';
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
function processContent(){
  if(S.fileType!=='epub')S.chapters=S.fileType==='md'?splitMD(S.rawText):splitTxt(S.rawText);
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
function sanitizeHTML(html){
  var ALLOWED_TAGS=/^(p|br|hr|h[1-6]|ul|ol|li|blockquote|pre|code|em|strong|b|i|u|s|a|span|div|table|thead|tbody|tr|td|th|img|sub|sup|small|mark|dl|dt|dd|figure|figcaption|section|article|header|footer|nav|abbr|cite|dfn|kbd|samp|var|time|ruby|rt|rp|wbr)$/i;
  var ALLOWED_ATTRS=/^(href|src|alt|title|class|id|colspan|rowspan|width|height|datetime|cite|dir|lang|role|aria-[\w-]+)$/i;
  var UNSAFE_SCHEMES=/^\s*(?:javascript|vbscript):/i;
  var doc=_dp.parseFromString(html,'text/html');
  var walker=document.createTreeWalker(doc.body,NodeFilter.SHOW_ELEMENT);
  var toRemove=[];
  while(walker.nextNode()){
    var el=walker.currentNode;
    if(!ALLOWED_TAGS.test(el.tagName)){toRemove.push(el);continue}
    var attrs=Array.prototype.slice.call(el.attributes);
    for(var i=0;i<attrs.length;i++){
      var name=attrs[i].name.toLowerCase();
      if(!ALLOWED_ATTRS.test(name)){el.removeAttribute(attrs[i].name);continue}
      if(UNSAFE_SCHEMES.test(attrs[i].value)||(name==='href'&&/^\s*data:/i.test(attrs[i].value))){el.removeAttribute(attrs[i].name)}
    }
  }
  for(var j=toRemove.length-1;j>=0;j--){
    var parent=toRemove[j].parentNode;if(!parent)continue;
    while(toRemove[j].firstChild)parent.insertBefore(toRemove[j].firstChild,toRemove[j]);
    parent.removeChild(toRemove[j]);
  }
  return doc.body.innerHTML;
}
function txtToHtml(t){var ls=t.split(/\n/),h=[],inP=false,inBq=false,inUl=false,inOl=false;for(var i=0;i<ls.length;i++){var raw=ls[i],tr=raw.trim();if(!tr){closeTags();continue}var hm=tr.match(/^(#{1,3})\s(.+)/);if(hm){closeTags();h.push('<h'+hm[1].length+'>'+esc(hm[2])+'</h'+hm[1].length+'>');continue}var bqm=tr.match(/^>\s?(.+)/);if(bqm){if(inP){h.push('</p>');inP=false}if(!inBq){h.push('<blockquote>');inBq=true}h.push('<p>'+esc(bqm[1])+'</p>');continue}var ulm=tr.match(/^[-*+]\s(.+)/);if(ulm){closeInline();if(inOl){h.push('</ol>');inOl=false}if(!inUl){h.push('<ul>');inUl=true}h.push('<li>'+esc(ulm[1])+'</li>');continue}var olm=tr.match(/^\d+[.)]\s(.+)/);if(olm){closeInline();if(inUl){h.push('</ul>');inUl=false}if(!inOl){h.push('<ol>');inOl=true}h.push('<li>'+esc(olm[1])+'</li>');continue}closeInline();if(!inP){h.push('<p>');inP=true}h.push(esc(tr))}function closeTags(){if(inP){h.push('</p>');inP=false}if(inBq){h.push('</blockquote>');inBq=false}if(inUl){h.push('</ul>');inUl=false}if(inOl){h.push('</ol>');inOl=false}}function closeInline(){if(inP){h.push('</p>');inP=false}if(inBq){h.push('</blockquote>');inBq=false}}if(inP)h.push('</p>');if(inBq)h.push('</blockquote>');if(inUl)h.push('</ul>');if(inOl)h.push('</ol>');return h.join('')}

/* ===== Seamless Rendering ===== */
function createChapterBlock(idx){var ch=S.chapters[idx];if(!ch)return null;var d=document.createElement('div');d.className='ch-block';d.dataset.idx=idx;var t=document.createElement('h2');t.className='ch-title';t.textContent=ch.title||'';d.appendChild(t);var b=document.createElement('div');b.className='ch-body';b.innerHTML=ch.html?sanitizeHTML(ch.html):txtToHtml(ch.content||'');d.appendChild(b);return d}
function createSep(){var d=document.createElement('div');d.className='ch-sep';d.innerHTML='<div class="ch-sep-dot"></div><div class="ch-sep-dot"></div><div class="ch-sep-dot"></div>';return d}
function initSeamless(chapter,offset){contentInner.innerHTML='';firstLoaded=-1;lastLoaded=-1;var st=Math.max(0,chapter-1),en=Math.min(S.chapters.length-1,chapter+1);for(var i=st;i<=en;i++){var blk=createChapterBlock(i);if(!blk)continue;if(contentInner.children.length>0)contentInner.appendChild(createSep());contentInner.appendChild(blk);if(firstLoaded===-1)firstLoaded=i;lastLoaded=i}S.currentChapter=chapter;requestAnimationFrame(function(){var bl=contentInner.querySelector('[data-idx="'+chapter+'"]');if(bl)contentEl.scrollTop=bl.offsetTop+(offset||0);updateProgress();highlightToc();updateBmBtn()})}
function appendChapter(idx){if(idx>=S.chapters.length||idx<=lastLoaded)return;if(contentInner.children.length>0)contentInner.appendChild(createSep());var blk=createChapterBlock(idx);if(blk){contentInner.appendChild(blk);lastLoaded=idx;trimChapters()}}
function prependChapter(idx){if(idx<0||idx>=firstLoaded)return;var oH=contentEl.scrollHeight,oT=contentEl.scrollTop;var bl=createChapterBlock(idx);if(!bl)return;var fc=contentInner.firstChild;if(fc){var s=createSep();contentInner.insertBefore(s,fc);contentInner.insertBefore(bl,s)}else contentInner.appendChild(bl);firstLoaded=idx;isAdjusting=true;contentEl.scrollTop=oT+(contentEl.scrollHeight-oH);requestAnimationFrame(function(){isAdjusting=false;trimChapters()})}
function checkInfinite(){if(isAdjusting||!S.chapters.length)return;var st=contentEl.scrollTop,sb=st+contentEl.clientHeight,sh=contentEl.scrollHeight;if(sb>sh-SCROLL_BOUND&&lastLoaded<S.chapters.length-1)appendChapter(lastLoaded+1);if(st<SCROLL_BOUND&&firstLoaded>0)prependChapter(firstLoaded-1)}
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
var svTimer;function afterScroll(){if(isAdjusting)return;updateReadingChapter();updateProgress();checkInfinite();clearTimeout(svTimer);svTimer=setTimeout(saveProg,SAVE_DELAY)}

/* ===== Progress ===== */
function getProgressData(){if(_progData&&_progData.len===S.chapters.length)return _progData;var total=0,cum=[0];for(var i=0;i<S.chapters.length;i++){total+=Math.max(1,(S.chapters[i].content||'').length);cum.push(total)}_progData={cum:cum,total:total,len:S.chapters.length};return _progData}
function getAccurateProgress(){if(!S.chapters||!S.chapters.length)return 0;var pd=getProgressData();if(!pd.total)return 0;var bl=contentInner.querySelector('[data-idx="'+S.currentChapter+'"]');if(!bl)return pd.cum[S.currentChapter]/pd.total;var cs=pd.cum[S.currentChapter],cl=pd.cum[S.currentChapter+1]-cs;var so=contentEl.scrollTop-bl.offsetTop,cp=bl.offsetHeight>0?Math.max(0,Math.min(1,so/bl.offsetHeight)):0;return(cs+cl*cp)/pd.total}
function updateProgress(){var pct=getAccurateProgress(),pi=Math.round(pct*100);progressFill.style.width=pi+'%';progressThumb.style.left=pi+'%';progressTip.style.left=pi+'%';var ch=S.chapters[S.currentChapter];progressTip.textContent=(ch?ch.title:'')+' · '+pi+'%'}
function jumpToPercent(pct){var pd=getProgressData();if(!pd.total)return;var tc=pct*pd.total,ci=0;for(var i=0;i<pd.cum.length-1;i++){if(pd.cum[i+1]>=tc){ci=i;break}ci=i+1}ci=Math.min(ci,S.chapters.length-1);var cs=pd.cum[ci],cl=pd.cum[ci+1]-cs,cp2=cl>0?(tc-cs)/cl:0;var bl=contentInner.querySelector('[data-idx="'+ci+'"]');if(bl){contentEl.scrollTop=bl.offsetTop+cp2*bl.offsetHeight;if(ci!==S.currentChapter){S.currentChapter=ci;highlightToc();updateBmBtn()}}else{goToChapter(ci);requestAnimationFrame(function(){var b2=contentInner.querySelector('[data-idx="'+ci+'"]');if(b2)contentEl.scrollTop=b2.offsetTop+cp2*b2.offsetHeight})}}
function setupProgressDrag(){var dragging=false;function getPct(e){var r=progressTrack.getBoundingClientRect();var cx=e.touches?e.touches[0].clientX:e.clientX;return Math.max(0,Math.min(1,(cx-r.left)/r.width))}function visual(p){var pd=getProgressData(),pi=Math.round(p*100);progressFill.style.width=pi+'%';progressThumb.style.left=pi+'%';progressTip.style.left=pi+'%';var tc=p*pd.total,ci=0;for(var i=0;i<pd.cum.length-1;i++){if(pd.cum[i+1]>=tc){ci=i;break}ci=i+1}ci=Math.min(ci,S.chapters.length-1);progressTip.textContent=(S.chapters[ci]?S.chapters[ci].title:'')+' · '+pi+'%'}function start(e){if(!S.chapters.length)return;dragging=true;progressTrack.classList.add('active');visual(getPct(e))}function move(e){if(!dragging)return;visual(getPct(e));e.preventDefault()}function end(e){if(!dragging)return;dragging=false;progressTrack.classList.remove('active');var r=progressTrack.getBoundingClientRect();var cx=e.changedTouches?e.changedTouches[0].clientX:e.clientX;jumpToPercent(Math.max(0,Math.min(1,(cx-r.left)/r.width)))}on(progressTrack,'mousedown',start);on(document,'mousemove',move);on(document,'mouseup',end);on(progressTrack,'touchstart',function(e){e.preventDefault();start(e)},{passive:false});on(document,'touchmove',move,{passive:false});on(document,'touchend',end)}

/* ===== Bookmarks ===== */
function getBookmarks(){try{return JSON.parse(localStorage.getItem('jd_bm_'+S.fileName))||[]}catch(e){return[]}}
function saveBookmarks(bms){try{localStorage.setItem('jd_bm_'+S.fileName,JSON.stringify(bms))}catch(e){}}
function getFirstVisibleLine(){var els=contentInner.querySelectorAll('p, h2, h3, h4, li, blockquote, pre');var rect=contentEl.getBoundingClientRect();var vt=rect.top,vb=rect.bottom;var checked=0;for(var i=0;i<els.length;i++){var r=els[i].getBoundingClientRect();if(r.bottom<=vt||r.top>=vb)continue;checked++;if(checked>10)break;var text=els[i].textContent.trim();if(text)return text.slice(0,SNIP_MAX)}return''}
function toggleBookmark(){if(!S.fileName)return;var bms=getBookmarks();var exist=-1;for(var i=0;i<bms.length;i++){if(bms[i].ch===S.currentChapter&&Math.abs(bms[i].offset-getChapterOffset())<BM_OFFSET_TOL){exist=i;break}}if(exist>=0){bms.splice(exist,1);toast('已移除书签')}else{var firstLine=getFirstVisibleLine();if(!firstLine){toast('书签保存失败');return}var pct=Math.round(getAccurateProgress()*100);bms.push({ch:S.currentChapter,offset:getChapterOffset(),snip:firstLine,progress:pct,ts:Date.now()});toast('已添加书签')}saveBookmarks(bms);renderBookmarks();updateBmBtn()}
function getChapterOffset(){var bl=contentInner.querySelector('[data-idx="'+S.currentChapter+'"]');return bl?contentEl.scrollTop-bl.offsetTop:0}
function deleteBookmark(i){var bms=getBookmarks();bms.splice(i,1);saveBookmarks(bms);renderBookmarks();updateBmBtn();toast('已删除书签')}
function renderBookmarks(){var bms=getBookmarks();if(!bms.length){bmList.innerHTML='<div class="bm-empty">暂无书签<br><small>阅读时点击书签图标添加</small></div>';return}bmList.innerHTML=bms.map(function(b,i){var cn=S.chapters[b.ch]?S.chapters[b.ch].title:'未知章节';var dt=new Date(b.ts);var ds=(dt.getMonth()+1)+'/'+dt.getDate()+' '+dt.getHours()+':'+String(dt.getMinutes()).padStart(2,'0');var prog=b.progress!==undefined?'<span class="bm-prog">'+b.progress+'</span>':'';return '<div class="bm-item" onclick="J.go('+b.ch+','+b.offset+')"><div class="bm-snippet">'+esc(b.snip||'')+'</div><div class="bm-meta"><span>'+cn+'</span><span>'+ds+'</span>'+prog+'</div><button class="bm-del" onclick="event.stopPropagation();J.delBm('+i+')" title="删除"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>'}).join('')}
function updateBmBtn(){var bms=getBookmarks();var on2=false;for(var i=0;i<bms.length;i++){if(bms[i].ch===S.currentChapter&&Math.abs(bms[i].offset-getChapterOffset())<BM_OFFSET_TOL){on2=true;break}}var btn=$('btn-bm');if(!btn)return;btn.classList.toggle('on',on2);var svg=btn.querySelector('svg');if(svg)svg.setAttribute('fill',on2?'currentColor':'none')}

/* ===== Search ===== */
function openSearch(){searchBar.classList.add('open');toolbar.classList.add('visible');searchInput.focus();searchInput.select()}
function closeSearch(){searchBar.classList.remove('open');searchInput.value='';S.searchQuery='';S.searchResults=[];S.searchIdx=-1;clearHighlights();updateSearchCount()}
function doSearch(){var q=searchInput.value.trim();S.searchQuery=q;if(!q){S.searchResults=[];S.searchIdx=-1;clearHighlights();updateSearchCount();return}var r=[],ql=q.toLowerCase();for(var i=0;i<S.chapters.length;i++){var t=S.chapters[i].content||'',tl=t.toLowerCase(),p=0;while((p=tl.indexOf(ql,p))!==-1){r.push({ch:i,pos:p});p+=q.length}}S.searchResults=r;S.searchIdx=r.length?0:-1;if(S.searchIdx>=0)navigateToResult();else{clearHighlights();updateSearchCount()}}
function navigateToResult(){var r=S.searchResults[S.searchIdx];if(!r)return;var bl=contentInner.querySelector('[data-idx="'+r.ch+'"]');if(bl){applyHighlights();scrollToActive()}else{goToChapter(r.ch);requestAnimationFrame(function(){applyHighlights();scrollToActive()})}updateSearchCount()}
function applyHighlights(){clearHighlights();if(!S.searchQuery)return;var q2=S.searchQuery,blocks=contentInner.querySelectorAll('.ch-block');for(var bi=0;bi<blocks.length;bi++){var body=blocks[bi].querySelector('.ch-body');if(!body||body.textContent.toLowerCase().indexOf(q2)===-1)continue;var w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),ns=[];while(w.nextNode())ns.push(w.currentNode);for(var ni=0;ni<ns.length;ni++){var nd=ns[ni],t=nd.textContent,l=t.toLowerCase(),ql=q2.toLowerCase(),p=l.indexOf(ql);if(p===-1)continue;var f=document.createDocumentFragment(),la=0;while(p!==-1){f.appendChild(document.createTextNode(t.slice(la,p)));var m=document.createElement('mark');m.className='shl';m.textContent=t.slice(p,p+q2.length);f.appendChild(m);la=p+q2.length;p=l.indexOf(ql,la)}f.appendChild(document.createTextNode(t.slice(la)));nd.parentNode.replaceChild(f,nd)}}highlightActiveMark()}
function clearHighlights(){contentInner.querySelectorAll('mark.shl').forEach(function(m){m.replaceWith(document.createTextNode(m.textContent))});contentInner.normalize()}
function highlightActiveMark(){var r=S.searchResults[S.searchIdx];if(!r||r.ch!==S.currentChapter)return;var base=0;for(var i=0;i<r.ch;i++){for(var j=0;j<S.searchResults.length;j++){if(S.searchResults[j].ch===i)base++}}var idx=S.searchIdx-base;var ms=contentInner.querySelectorAll('mark.shl');if(idx>=0&&idx<ms.length){ms.forEach(function(m){m.classList.remove('act')});ms[idx].classList.add('act')}}
function scrollToActive(){var a=contentInner.querySelector('mark.shl.act');if(a)a.scrollIntoView({behavior:'smooth',block:'center'})}
function searchPrev(){if(!S.searchResults.length)return;S.searchIdx=(S.searchIdx-1+S.searchResults.length)%S.searchResults.length;navigateToResult()}
function searchNext(){if(!S.searchResults.length)return;S.searchIdx=(S.searchIdx+1)%S.searchResults.length;navigateToResult()}
function updateSearchCount(){searchCount.textContent=S.searchResults.length?(S.searchIdx+1)+'/'+S.searchResults.length:''}

/* ===== TOC ===== */
function buildTOC(){var el=$('sidebar-title');if(el)el.textContent=S.fileName.replace(/\.[^.]+$/,'');var el2=$('sidebar-info');if(el2)el2.textContent=S.chapters.length+' 章 · '+fmtSize(S.fileSize);tocList.innerHTML=S.chapters.map(function(c,i){return '<div class="toc-item" data-i="'+i+'" onclick="J.go('+i+')">'+esc(c.title||'')+'</div>'}).join('')}
function highlightToc(){var curEl=null;tocList.querySelectorAll('.toc-item').forEach(function(el){var isActive=+el.dataset.i===S.currentChapter;el.classList.toggle('current',isActive);if(isActive)curEl=el});if(curEl)curEl.scrollIntoView({block:'nearest',behavior:'smooth'})}

/* ===== Save/Load Progress ===== */
function saveProg(){try{var a=JSON.parse(localStorage.getItem('jd_p')||'{}');var pct=0;try{pct=Math.round(getAccurateProgress()*100)}catch(e){}a[S.fileName]={ch:S.currentChapter,offset:getChapterOffset(),pct:pct,ts:Date.now()};localStorage.setItem('jd_p',JSON.stringify(a))}catch(e){}}
function loadProg(n){try{return(JSON.parse(localStorage.getItem('jd_p')||'{}'))[n]||null}catch(e){return null}}

/* ===== Events ===== */
function setupSettingsEvents(){
  on($('range-fs'),'input',function(e){S.fontSize=+e.target.value;applySettings();saveSettings()});
  on($('range-lh'),'input',function(e){S.lineHeight=+e.target.value;applySettings();saveSettings()});
  document.querySelectorAll('.theme-toggle button').forEach(function(b){on(b,'click',function(){S.theme=b.dataset.t;applySettings();saveSettings()})});
  document.querySelectorAll('[data-pad]').forEach(function(b){on(b,'click',function(){S.padding=b.dataset.pad;applySettings();saveSettings()})});
}
function setupEvents(){
  on($('bs-import'),'click',function(){fileInput.click()});
  on(fileInput,'change',function(e){handleFile(e.target.files[0]);fileInput.value=''});
  on($('bs-theme-btn'),'click',toggleTheme);
  on(document,'dragover',function(e){e.preventDefault()});
  on(document,'drop',function(e){e.preventDefault();if(e.dataTransfer&&e.dataTransfer.files[0])handleFile(e.dataTransfer.files[0])});
  var tbTimer;function showTB(){if(!toolbar)return;toolbar.classList.add('visible');clearTimeout(tbTimer);tbTimer=setTimeout(function(){toolbar.classList.remove('visible')},TB_HIDE_MS)}
  on(contentEl,'mousemove',showTB);
  on(contentEl,'scroll',function(){showTB();if(!isAdjusting)afterScroll()},{passive:true});
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
  on(window,'beforeunload',function(){stopReadingTimer();if(S.fileName)saveProg()});
  on(document,'visibilitychange',function(){if(document.hidden){if(reader.classList.contains('active'))stopReadingTimer()}else{if(reader.classList.contains('active'))startReadingTimer()}});
  var tx=0;on(contentEl,'touchstart',function(e){tx=e.touches[0].clientX},{passive:true});
  on(contentEl,'touchend',function(e){if(!S.chapters.length)return;var dx=e.changedTouches[0].clientX-tx;if(Math.abs(dx)>SWIPE_MIN){dx>0?goToChapter(Math.max(0,S.currentChapter-1)):goToChapter(Math.min(S.chapters.length-1,S.currentChapter+1))}},{passive:true});
  on(document,'keydown',function(e){if(e.key==='Escape')closeAllPanels();if((e.ctrlKey||e.metaKey)&&e.key==='f'){e.preventDefault();openSearch()}});
}
function togglePanel(n,force){if(n==='sidebar'){var o=force!==undefined?force:!sidebar.classList.contains('open');sidebar.classList.toggle('open',o);sidebarOverlay.classList.toggle('show',o);var sw=o?sidebar.offsetWidth+'px':'';toolbar.style.left=sw;searchBar.style.left=sw;if(o)highlightToc()}else{var o2=force!==undefined?force:!settingsEl.classList.contains('open');settingsEl.classList.toggle('open',o2);settingsOverlay.classList.toggle('show',o2);if(o2)updateStatsDisplay()}}

/* ===== Helpers ===== */
function showLoading(m){if(loading){loading.classList.add('show');if(loadingText)loadingText.textContent=m||'加载中...'}}
function hideLoading(){if(loading)loading.classList.remove('show')}
function showReader(){hideBookshelf();hideLoading();buildTOC();if(reader)reader.classList.add('active');if(tbTitle)tbTitle.textContent=S.fileName.replace(/\.[^.]+$/,'');startReadingTimer()}
function fmtSize(b){return b<1024?b+'B':b<1048576?(b/1024).toFixed(1)+'KB':(b/1048576).toFixed(1)+'MB'}
function toast(msg){if(!toastEl)return;toastEl.textContent=msg;toastEl.classList.add('show');clearTimeout(toastEl._t);toastEl._t=setTimeout(function(){toastEl.classList.remove('show')},TOAST_MS)}
function debounce(fn,ms){var t;return function(){var a=arguments,c=this;clearTimeout(t);t=setTimeout(function(){fn.apply(c,a)},ms)}}
function getStats(){try{return JSON.parse(localStorage.getItem('jd_stats')||'{"totalMin":0,"todayMin":0,"date":"","sessions":0,"books":{}}')}catch(e){return{totalMin:0,todayMin:0,date:'',sessions:0,books:{}}}}
function saveStats(s){try{localStorage.setItem('jd_stats',JSON.stringify(s))}catch(e){}}
function updateStatsDisplay(){var s=getStats(),b=s.books[S.fileName];$('stats-total').textContent=s.totalMin+' 分钟';$('stats-today').textContent=s.todayMin+' 分钟';$('stats-book').textContent=(b?b.min:0)+' 分钟'}
function tickReading(){if(!_rs)return;var now=Date.now(),elapsed=Math.floor((now-_rs)/60000);if(elapsed<1)return;var s=getStats(),today=new Date().toISOString().slice(0,10);if(s.date!==today){s.todayMin=0;s.date=today}s.totalMin+=elapsed;s.todayMin+=elapsed;if(S.fileName){if(!s.books[S.fileName])s.books[S.fileName]={min:0,opens:0};s.books[S.fileName].min+=elapsed}saveStats(s);_rs=now;updateStatsDisplay()}
function startReadingTimer(){stopReadingTimer();_rs=Date.now();_rt=setInterval(tickReading,60000);var s=getStats();s.sessions++;saveStats(s);updateStatsDisplay()}
function stopReadingTimer(){if(_rt){clearInterval(_rt);_rt=null}tickReading();_rs=0}
function toggleTheme(){S.theme=S.theme==='light'?'dark':'light';applySettings();saveSettings()}
function closeAllPanels(){togglePanel('sidebar',false);togglePanel('settings',false);if(searchBar.classList.contains('open'))closeSearch()}
function goToChapter(idx){if(idx<0||idx>=S.chapters.length)return;togglePanel('sidebar',false);initSeamless(idx,0)}
function q(s){return'"'+s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/\\/g,'\\\\')+'"'}

window.J={openBook:loadBookFromShelf,delBook:deleteBook,go:function(ch,off){goToChapter(ch);if(off)requestAnimationFrame(function(){var bl=contentInner.querySelector('[data-idx="'+ch+'"]');if(bl)contentEl.scrollTop=bl.offsetTop+off})},delBm:deleteBookmark};

})();
