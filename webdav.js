/* webdav.js — WebDAV 远程书架模块（自 script.js 拆分）
 * 职责: 服务器连接/认证、PROPFIND 目录浏览、文件下载导入、
 *       账号密码 AES-GCM 加密存储（密钥存 IndexedDB）、模态框交互
 * 依赖: 以下函数/常量由 script.js 导出到 window：
 *       openDB / toast / showLoading / hideLoading / fmtSize / S /
 *       dbSave / addToLib / decodeBuffer / generateCoverDataUrl /
 *       processContent / finishEpubImport / parseEPUB / PROC_DELAY
 * 导出: window.WebDAV = { isOpen, hide, trapFocus }（供 script.js 全局键盘处理）
 */
(function(){
'use strict';
var $=function(id){return document.getElementById(id)};
var on=function(el,ev,fn,opt){if(el)el.addEventListener(ev,fn,opt||false)};

/* ===== DOM 引用（原 script.js 顶部） ===== */
var importDropdownMenu=$('import-dropdown-menu');
var webdavModal=$('webdav-modal'),webdavModalTitle=$('webdav-modal-title');
var webdavStepUrl=$('webdav-step-url'),webdavStepAuth=$('webdav-step-auth'),webdavStepBrowse=$('webdav-step-browse');
var webdavUrlInput=$('webdav-url'),webdavUsernameInput=$('webdav-username'),webdavPasswordInput=$('webdav-password'),webdavRememberCheckbox=$('webdav-remember');
var webdavBreadcrumb=$('webdav-breadcrumb'),webdavFileList=$('webdav-file-list');

/* ===== 状态 ===== */
var WEB_STORE='webdavSecrets';
var webdavBaseUrl='',webdavAuth='',webdavCurrentPath='/',webdavCredentials={url:'',username:'',password:'',remember:false},webdavLastFocus=null;

/* ===== 密码加密存储（AES-GCM，密钥持久化于 IndexedDB） ===== */
function webdavGetCryptoKey(cb){
  if(!window.crypto||!window.crypto.subtle){cb(null);return}
  window.openDB(function(db){
    if(!db||!db.objectStoreNames.contains(WEB_STORE)){cb(null);return}
    var tx=db.transaction(WEB_STORE,'readonly'),r=tx.objectStore(WEB_STORE).get('credentials');
    r.onsuccess=function(){
      if(r.result&&r.result.key){cb(r.result.key);return}
      window.crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']).then(function(key){
        window.openDB(function(db2){
          if(!db2){cb(null);return}
          var tx2=db2.transaction(WEB_STORE,'readwrite');
          tx2.objectStore(WEB_STORE).put({id:'credentials',key:key});
          tx2.oncomplete=function(){cb(key)};tx2.onerror=function(){cb(null)};
        });
      }).catch(function(){cb(null)});
    };
    r.onerror=function(){cb(null)};
  });
}
function bytesToB64(bytes){var s='';for(var i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]);return btoa(s)}
function b64ToBytes(value){var s=atob(value),out=new Uint8Array(s.length);for(var i=0;i<s.length;i++)out[i]=s.charCodeAt(i);return out}
function webdavEncryptPassword(password,cb){
  webdavGetCryptoKey(function(key){
    if(!key){cb(null);return}
    var iv=window.crypto.getRandomValues(new Uint8Array(12));
    window.crypto.subtle.encrypt({name:'AES-GCM',iv:iv},key,new TextEncoder().encode(password)).then(function(data){cb({iv:bytesToB64(iv),cipher:bytesToB64(new Uint8Array(data))})}).catch(function(){cb(null)});
  });
}
function webdavDecryptPassword(saved,cb){
  if(!saved||!saved.iv||!saved.cipher){cb('');return}
  webdavGetCryptoKey(function(key){
    if(!key){cb('');return}
    try{window.crypto.subtle.decrypt({name:'AES-GCM',iv:b64ToBytes(saved.iv)},key,b64ToBytes(saved.cipher)).then(function(data){cb(new TextDecoder().decode(data))}).catch(function(){cb('')})}catch(e){cb('')}
  });
}

/* ===== 凭据加载/保存 ===== */
function loadWebDAVCredentials(){
  try{
    var saved=JSON.parse(localStorage.getItem('jd_webdav')||'null');
    if(saved){
      webdavCredentials={url:saved.url||'',username:saved.username||'',password:'',remember:false};
      if(saved.url)webdavUrlInput.value=saved.url;
      if(saved.username)webdavUsernameInput.value=saved.username;
      webdavRememberCheckbox.checked=false;
      if(saved.password){
        /* 迁移历史明文记录：立即替换为加密结构。 */
        try{localStorage.setItem('jd_webdav',JSON.stringify({v:2,url:saved.url||'',username:saved.username||'',remember:false}))}catch(err){}
        webdavCredentials.password=saved.password;webdavPasswordInput.value=saved.password;webdavRememberCheckbox.checked=true;
        saveWebDAVCredentials();
      }else if(saved.remember&&saved.iv&&saved.cipher){
        webdavDecryptPassword(saved,function(password){
          if(!webdavModal.classList.contains('show'))return;
          if(password){webdavCredentials.password=password;webdavPasswordInput.value=password;webdavRememberCheckbox.checked=true}
        });
      }
    }
  }catch(e){}
}
function saveWebDAVCredentials(){
  var base={v:2,url:webdavUrlInput.value.trim(),username:webdavUsernameInput.value,remember:false};
  if(!webdavRememberCheckbox.checked){
    webdavCredentials={url:base.url,username:base.username,password:'',remember:false};
    try{localStorage.setItem('jd_webdav',JSON.stringify(base))}catch(e){}
    return;
  }
  var password=webdavPasswordInput.value;
  webdavCredentials={url:base.url,username:base.username,password:password,remember:true};
  webdavEncryptPassword(password,function(secret){
    if(!secret){webdavRememberCheckbox.checked=false;webdavCredentials.remember=false;try{localStorage.setItem('jd_webdav',JSON.stringify(base))}catch(e){}window.toast('当前浏览器无法安全记住密码');return}
    base.remember=true;base.iv=secret.iv;base.cipher=secret.cipher;
    try{localStorage.setItem('jd_webdav',JSON.stringify(base))}catch(e){}
  });
}

/* ===== 模态框 ===== */
function showWebDAVModal(){
  webdavLastFocus=document.activeElement;
  webdavCredentials={url:'',username:'',password:'',remember:false};
  webdavUrlInput.value='';webdavUsernameInput.value='';webdavPasswordInput.value='';webdavRememberCheckbox.checked=false;
  loadWebDAVCredentials();
  webdavStepUrl.style.display='';
  webdavStepAuth.style.display='none';
  webdavStepBrowse.style.display='none';
  webdavModalTitle.textContent='远程上传';
  webdavModal.classList.add('show');
  webdavModal.setAttribute('aria-hidden','false');
  requestAnimationFrame(function(){requestAnimationFrame(function(){if(webdavModal.classList.contains('show'))webdavUrlInput.focus()})});
}
function hideWebDAVModal(){
  webdavModal.classList.remove('show');webdavModal.setAttribute('aria-hidden','true');
  if(webdavLastFocus&&typeof webdavLastFocus.focus==='function')webdavLastFocus.focus();
  webdavLastFocus=null;
}
function trapWebDAVFocus(e){
  if(!webdavModal.classList.contains('show')||e.key!=='Tab')return;
  var items=webdavModal.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
  var visible=[];for(var i=0;i<items.length;i++)if(items[i].offsetParent!==null)visible.push(items[i]);
  if(!visible.length){e.preventDefault();return}
  var current=document.activeElement,idx=visible.indexOf(current);
  if(e.shiftKey&&(idx<=0)){e.preventDefault();visible[visible.length-1].focus()}
  else if(!e.shiftKey&&(idx===visible.length-1||idx<0)){e.preventDefault();visible[0].focus()}
}

/* ===== WebDAV 客户端 ===== */
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
        window.toast('认证失败，请输入用户名密码');
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
      size.textContent=window.fmtSize(item.size);
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
  window.showLoading('正在下载 '+item.name+'...');
  var path=item.href.replace(webdavBaseUrl.replace(/https?:\/\/[^\/]+/,''),'');
  webdavFetch(path).then(function(resp){
    if(!resp.ok)throw new Error('下载失败: '+resp.status);
    return resp.arrayBuffer();
  }).then(function(buf){
    var ext=webdavGetExt(item.name);
    var fileType=(ext==='md'||ext==='markdown')?'md':ext;
    var source=new Blob([buf],{type:ext==='epub'?'application/epub+zip':'text/plain'});
    window.S.fileName=item.name;
    window.S.fileSize=item.size;
    window.S.fileType=fileType;
    window.showLoading('正在解析内容...');
    setTimeout(function(){
      try{
        if(ext==='epub'){
          window.parseEPUB(buf,function(result,err){
            if(err||!result){window.hideLoading();window.toast('EPUB 解析失败: '+(err||'未知错误'));return}
            window.finishEpubImport(item.name,item.size,result,source,'webdav');
          });
        }else{
          window.S.rawText=window.decodeBuffer(buf);
          var cv=window.generateCoverDataUrl(item.name);
          window.addToLib(window.S.fileName,window.S.fileSize,window.S.fileType,cv,'webdav');
          window.dbSave(window.S.fileName,{text:window.S.rawText,type:window.S.fileType,size:window.S.fileSize,cover:cv},function(){});
          window.processContent();
          /* 导入后检测远端进度（checkpoint 下载） */
          (function(fname){
            if(!window.davSyncAvailable||!window.davSyncAvailable())return;
            window.davDownloadCheckpoint(fname,function(remote){
              if(!remote||!remote.prog)return;
              var localProg=window.loadProg?window.loadProg(fname):null;
              if(!localProg||window.davRemoteAhead(localProg,remote.prog)){
                setTimeout(function(){
                  window.confirmBox('检测到远端进度（第'+(remote.prog.ch+1)+'章 '+Math.round(remote.prog.pct||0)+'%），是否跳转？','跳转到远端进度',function(){
                    window.davApplyRemoteData(fname,remote);
                    setTimeout(function(){
                      var np=window.loadProg?window.loadProg(fname):null;
                      if(np){
                        if(np.pct&&np.pct>0&&window.jumpToPercent)window.jumpToPercent(np.pct);
                        else if(window.J)window.J.go(np.ch||0,np.offset||0);
                      }
                    },1200);
                  });
                },1500);
              }
            });
          })(window.S.fileName);
        }
      }catch(err){console.error(err);window.toast('文件解析失败: '+err.message);window.hideLoading()}
    },window.PROC_DELAY);
  }).catch(function(err){
    window.hideLoading();
    window.toast('下载失败: '+err.message);
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
  if(!url){window.toast('请输入服务器地址');return}
  if(!url.match(/^https?:\/\//)){url='http://'+url;webdavUrlInput.value=url}
  var urlObj=new URL(url);
  var basePath=urlObj.pathname.replace(/\/$/,'')||'/';
  webdavBaseUrl=urlObj.origin;
  webdavCurrentPath=basePath;
  saveWebDAVCredentials();
  window.showLoading('正在连接...');
  webdavPropfind(basePath,'0').then(function(resp){
    window.hideLoading();
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
    window.hideLoading();
    window.toast('无法连接到服务器，请检查地址是否正确');
  });
}
function webdavTestAuth(){
  window.showLoading('正在验证...');
  webdavPropfind(webdavCurrentPath,'0').then(function(resp){
    window.hideLoading();
    if(resp.status===401){
      window.toast('账号或密码错误');
      showWebDAVStep('auth');
      return;
    }
    if(!resp.ok)throw new Error('验证失败: '+resp.status);
    saveWebDAVCredentials();
    showWebDAVStep('browse');
    webdavListDir(webdavCurrentPath);
  }).catch(function(err){
    window.hideLoading();
    window.toast('验证失败: '+err.message);
    showWebDAVStep('auth');
  });
}
function webdavLogin(){
  var username=webdavUsernameInput.value;
  var password=webdavPasswordInput.value;
  if(!username){window.toast('请输入用户名');return}
  webdavAuth=webdavMakeAuth(username,password);
  window.showLoading('正在验证...');
  webdavPropfind(webdavCurrentPath,'0').then(function(resp){
    window.hideLoading();
    if(resp.status===401){
      window.toast('账号或密码错误');
      return;
    }
    if(!resp.ok)throw new Error('验证失败: '+resp.status);
    saveWebDAVCredentials();
    showWebDAVStep('browse');
    webdavListDir(webdavCurrentPath);
  }).catch(function(err){
    window.hideLoading();
    window.toast('验证失败: '+err.message);
  });
}

/* ===== 事件绑定（原 script.js setupEvents 中的 WebDAV 部分） ===== */
on($('import-webdav'),'click',function(e){
  e.stopPropagation();
  importDropdownMenu.classList.remove('show');
  showWebDAVModal();
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
on(webdavUrlInput,'keydown',function(e){if(e.key==='Enter'){e.preventDefault();webdavConnect()}});
on(webdavPasswordInput,'keydown',function(e){if(e.key==='Enter'){e.preventDefault();webdavLogin()}});

/* ===== 导出（供 script.js 全局键盘处理） ===== */

/* ===== 配置同步：.easydu 隐藏目录（checkpoint 模式） ===== */
/* 书籍全部配置 -> <挂载目录>/.easydu/<encodeURIComponent(书名)>.json */
function davSyncBasePath(){return(webdavCurrentPath||'/').replace(/\/$/,'')+'/.easydu'}
function davSyncBookPath(name){return davSyncBasePath()+'/'+encodeURIComponent(name)+'.json'}
function davSyncEnabled(){return!!webdavBaseUrl}
function davSyncPut(path,data){
  return webdavFetch(path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
}
function davSyncGet(path){
  return webdavFetch(path).then(function(resp){
    if(resp.status===404)return{ok:true,data:null};
    if(!resp.ok)return{ok:false,error:'HTTP '+resp.status};
    return resp.json().then(function(d){return{ok:true,data:d}}).catch(function(){return{ok:true,data:null}});
  }).catch(function(e){return{ok:false,error:String(e&&e.message||e)}});
}
function davSyncDelete(path){return webdavFetch(path,{method:'DELETE'})}
/* 确保 .easydu 目录存在（已存在时 MKCOL 返回 405/409，忽略即可） */
function davSyncEnsureDir(){return webdavFetch(davSyncBasePath(),{method:'MKCOL'}).catch(function(){})}
function davSyncSaveBook(name,payload){return davSyncEnsureDir().then(function(){return davSyncPut(davSyncBookPath(name),payload)})}
function davSyncLoadBook(name){return davSyncGet(davSyncBookPath(name))}
function davSyncDeleteBook(name){return davSyncDelete(davSyncBookPath(name))}

window.WebDAV={
  isOpen:function(){return webdavModal.classList.contains('show')},
  hide:hideWebDAVModal,
  trapFocus:trapWebDAVFocus,
  syncEnabled:davSyncEnabled,
  syncSaveBook:davSyncSaveBook,
  syncLoadBook:davSyncLoadBook,
  syncDeleteBook:davSyncDeleteBook
};
})();
