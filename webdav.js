/* webdav.js — WebDAV 远程书架与同步模块（自 script.js 拆分）
 * 职责: WebDAV 配置管理（设置面板折叠组）、AES-GCM 凭据加密存储（密钥存 IndexedDB）、
 *       启动自动恢复连接、PROPFIND 目录浏览与文件导入、
 *       .easydu 隐藏目录阅读进度（checkpoint）云端同步
 * 依赖: script.js / IndexedDB 提供 openDB / toast / showLoading / hideLoading /
 *       fmtSize / S / dbSave / addToLib / decodeBuffer / generateCoverDataUrl /
 *       processContent / finishEpubImport / parseEPUB / PROC_DELAY / confirmBox
 * 导出: window.WebDAV = { isOpen, hide, trapFocus, isConfigured, syncEnabled,
 *                         syncSaveBook, syncLoadBook, syncDeleteBook }
 */
(function(){
'use strict';
var $=function(id){return document.getElementById(id)};
var on=function(el,ev,fn,opt){if(el)el.addEventListener(ev,fn,opt||false)};

/* ===== DOM 引用 ===== */
var importDropdownMenu=$('import-dropdown-menu');
var webdavModal=$('webdav-modal'),webdavModalTitle=$('webdav-modal-title');
var webdavStepBrowse=$('webdav-step-browse');
var webdavBreadcrumb=$('webdav-breadcrumb'),webdavFileList=$('webdav-file-list');

var webdavSettingsFold=$('webdav-settings-fold');
var webdavStatusBadge=$('webdav-status-badge');
var webdavCfgUrl=$('webdav-cfg-url'),webdavCfgUser=$('webdav-cfg-user'),webdavCfgPass=$('webdav-cfg-pass');
var webdavCfgSave=$('webdav-cfg-save'),webdavCfgClear=$('webdav-cfg-clear');
var webdavCfgMsg=$('webdav-cfg-msg');

/* ===== 状态 ===== */
var WEB_STORE='webdavSecrets';
var webdavBaseUrl='',webdavMountPath='/',webdavCurrentPath='/',webdavAuth='',webdavLastFocus=null;

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
  if(!password){cb(null);return}
  webdavGetCryptoKey(function(key){
    if(!key){cb(null);return}
    var iv=window.crypto.getRandomValues(new Uint8Array(12));
    window.crypto.subtle.encrypt({name:'AES-GCM',iv:iv},key,new TextEncoder().encode(password)).then(function(data){
      cb({iv:bytesToB64(iv),cipher:bytesToB64(new Uint8Array(data))});
    }).catch(function(){cb(null)});
  });
}
function webdavDecryptPassword(saved,cb){
  if(!saved||!saved.iv||!saved.cipher){cb('');return}
  webdavGetCryptoKey(function(key){
    if(!key){cb('');return}
    try{
      window.crypto.subtle.decrypt({name:'AES-GCM',iv:b64ToBytes(saved.iv)},key,b64ToBytes(saved.cipher)).then(function(data){
        cb(new TextDecoder().decode(data));
      }).catch(function(){cb('')});
    }catch(e){cb('')}
  });
}

function webdavMakeAuth(username,password){
  return 'Basic '+btoa(unescape(encodeURIComponent(username+':'+password)));
}
function webdavBuildHeaders(){
  var headers={};
  if(webdavAuth)headers['Authorization']=webdavAuth;
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

/* ===== XML 响应解析（兼容有/无命名空间前缀） ===== */
function getXmlChild(parent,localName){
  if(!parent)return null;
  if(parent.getElementsByTagNameNS){
    var list=parent.getElementsByTagNameNS('*',localName);
    if(list.length>0)return list[0];
  }
  return parent.querySelector(localName)||parent.querySelector('D\\:'+localName)||parent.querySelector('d\\:'+localName);
}
function webdavParseResponse(xml){
  var parser=new DOMParser();
  var doc=parser.parseFromString(xml,'application/xml');
  var responses=(doc.getElementsByTagNameNS?doc.getElementsByTagNameNS('*','response'):null);
  if(!responses||!responses.length)responses=doc.querySelectorAll('response');
  var items=[];
  for(var i=0;i<responses.length;i++){
    var resp=responses[i];
    var href=getXmlChild(resp,'href');
    if(!href)continue;
    var hrefText=decodeURIComponent(href.textContent);
    var propstat=getXmlChild(resp,'propstat');
    if(!propstat)continue;
    var prop=getXmlChild(propstat,'prop');
    if(!prop)continue;
    var resourcetype=getXmlChild(prop,'resourcetype');
    var isFolder=resourcetype?getXmlChild(resourcetype,'collection')!==null:false;
    var getcontentlength=getXmlChild(prop,'getcontentlength');
    var size=getcontentlength?parseInt(getcontentlength.textContent)||0:0;
    var getlastmodified=getXmlChild(prop,'getlastmodified');
    var modified=getlastmodified?getlastmodified.textContent:'';
    var name=hrefText.split('/').filter(Boolean).pop()||'';
    items.push({href:hrefText,name:name,isFolder:isFolder,size:size,modified:modified});
  }
  return items;
}
function webdavIsSupported(ext){
  if(!ext)return false;
  return['txt','md','markdown','epub'].indexOf(ext.toLowerCase())>=0;
}
function webdavGetExt(filename){return filename.split('.').pop().toLowerCase()}

/* ===== 配置判定与 UI 同步 ===== */
function isConfigured(){
  if(webdavBaseUrl)return true;
  try{
    var saved=JSON.parse(localStorage.getItem('jd_webdav')||'null');
    return!!(saved&&saved.url);
  }catch(e){return false}
}
function updateImportMenu(){
  var item=$('import-webdav');
  if(item){
    item.style.display=isConfigured()?'':'none';
  }
}
function updateStatusUI(status,msg,isError){
  if(webdavStatusBadge){
    if(status==='connected'){
      webdavStatusBadge.textContent='已连接';
      webdavStatusBadge.className='webdav-status-badge connected';
    }else if(status==='readonly'){
      webdavStatusBadge.textContent='只读';
      webdavStatusBadge.className='webdav-status-badge connected';
    }else if(status==='configured'){
      webdavStatusBadge.textContent='已配置';
      webdavStatusBadge.className='webdav-status-badge connected';
    }else if(status==='error'){
      webdavStatusBadge.textContent='连接异常';
      webdavStatusBadge.className='webdav-status-badge error';
    }else{
      webdavStatusBadge.textContent='未配置';
      webdavStatusBadge.className='webdav-status-badge disconnected';
    }
  }
  if(webdavCfgMsg){
    if(msg){
      webdavCfgMsg.style.display='';
      webdavCfgMsg.textContent=msg;
      webdavCfgMsg.style.background=isError?'rgba(220,53,69,.1)':'rgba(40,167,69,.1)';
      webdavCfgMsg.style.color=isError?'#dc3545':'#28a745';
      webdavCfgMsg.style.border='1px solid '+(isError?'rgba(220,53,69,.2)':'rgba(40,167,69,.2)');
    }else{
      webdavCfgMsg.style.display='none';
    }
  }
  updateImportMenu();
}

/* ===== 启动时自动静默加载凭据并恢复连接 ===== */
function initWebDAVOnBoot(){
  try{
    var saved=JSON.parse(localStorage.getItem('jd_webdav')||'null');
    if(saved&&saved.url){
      var raw=saved.url.trim();
      if(!raw.match(/^https?:\/\//))raw='https://'+raw;
      var uObj=new URL(raw);
      webdavBaseUrl=uObj.origin;
      webdavMountPath=uObj.pathname.replace(/\/$/,'')||'/';
      webdavCurrentPath=webdavMountPath;
      if(webdavCfgUrl)webdavCfgUrl.value=saved.url;
      if(webdavCfgUser)webdavCfgUser.value=saved.username||'';
      if(saved.password){
        /* 兼容历史明文密码：自动迁移为 AES-GCM 加密存储 */
        if(webdavCfgPass)webdavCfgPass.value=saved.password;
        webdavAuth=(saved.username||saved.password)?webdavMakeAuth(saved.username||'',saved.password):'';
        updateStatusUI('configured');
        saveWebDAVCredentials(saved.url,saved.username||'',saved.password,function(){});
      }else if(saved.iv&&saved.cipher){
        updateStatusUI('configured');
        webdavDecryptPassword(saved,function(pwd){
          if(pwd){
            if(webdavCfgPass)webdavCfgPass.value=pwd;
            webdavAuth=(saved.username||pwd)?webdavMakeAuth(saved.username||'',pwd):'';
          }
        });
      }else{
        webdavAuth=saved.username?webdavMakeAuth(saved.username,''):'';
        updateStatusUI('configured');
      }
    }else{
      updateStatusUI('unconfigured');
    }
  }catch(e){
    updateStatusUI('unconfigured');
  }
  updateImportMenu();
  if(isConfigured())setTimeout(syncRemoteCatsIfAvailable,1000);
}

/* ===== 保存凭据到 localStorage ===== */
function saveWebDAVCredentials(url,username,password,cb){
  var base={v:2,url:url,username:username||''};
  if(!password){
    try{localStorage.setItem('jd_webdav',JSON.stringify(base))}catch(e){}
    if(cb)cb();
    return;
  }
  webdavEncryptPassword(password,function(secret){
    if(secret){
      base.iv=secret.iv;
      base.cipher=secret.cipher;
    }
    try{localStorage.setItem('jd_webdav',JSON.stringify(base))}catch(e){}
    if(cb)cb();
  });
}

/* ===== 保存并测试连接 ===== */
function handleSaveAndTest(){
  var rawUrl=webdavCfgUrl?webdavCfgUrl.value.trim():'';
  if(!rawUrl){
    updateStatusUI('unconfigured','请输入 WebDAV 服务器地址',true);
    return;
  }
  if(!rawUrl.match(/^https?:\/\//)){
    rawUrl='https://'+rawUrl;
    if(webdavCfgUrl)webdavCfgUrl.value=rawUrl;
  }
  var uObj;
  try{
    uObj=new URL(rawUrl);
  }catch(e){
    updateStatusUI('error','服务器地址格式不正确',true);
    return;
  }
  var testOrigin=uObj.origin;
  var testPath=uObj.pathname.replace(/\/$/,'')||'/';
  var testUser=webdavCfgUser?webdavCfgUser.value.trim():'';
  var testPass=webdavCfgPass?webdavCfgPass.value:'';
  var testAuth=(testUser||testPass)?webdavMakeAuth(testUser,testPass):'';

  updateStatusUI('configured','正在连接并验证 WebDAV...',false);

  function executePropfind(origin,path,auth){
    var targetUrl=origin.replace(/\/$/,'')+'/'+path.replace(/^\//,'');
    var body='<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>';
    return fetch(targetUrl,{
      method:'PROPFIND',
      headers:Object.assign({'Content-Type':'application/xml','Depth':'0'},auth?{'Authorization':auth}:{}),
      body:body
    });
  }

  executePropfind(testOrigin,testPath,testAuth).then(function(resp){
    if(resp.status===401){
      updateStatusUI('error','认证失败 (HTTP 401)：用户名或密码错误',true);
      return;
    }
    /* 若用户输入的是根路径但返回 405/404，且疑似 AList 等，自动探测 /dav/ */
    if((resp.status===405||resp.status===404)&&testPath==='/'){
      return executePropfind(testOrigin,'/dav',testAuth).then(function(resp2){
        if(resp2.ok||resp2.status===207){
          testPath='/dav';
          if(webdavCfgUrl)webdavCfgUrl.value=testOrigin+'/dav/';
          return checkWriteAndPersist(testOrigin,testPath,testUser,testPass,testAuth);
        }
        var hint=(testOrigin.indexOf('alist')>=0||rawUrl.indexOf('alist')>=0)?'（提示：AList 的 WebDAV 路径通常为 /dav/）':'';
        updateStatusUI('error','服务器返回 HTTP '+resp.status+'：路径未开启 WebDAV '+hint,true);
      });
    }
    if(!resp.ok&&resp.status!==207){
      updateStatusUI('error','连接失败：HTTP '+resp.status,true);
      return;
    }
    return checkWriteAndPersist(testOrigin,testPath,testUser,testPass,testAuth);
  }).catch(function(err){
    updateStatusUI('error','无法连接到服务器: '+err.message,true);
  });
}

/* 探测写入权限并完成持久化存储 */
function checkWriteAndPersist(origin,path,user,pass,auth){
  var easyduPath=origin.replace(/\/$/,'')+'/'+path.replace(/^\//,'').replace(/\/$/,'')+'/.easydu';
  var testFilePath=easyduPath+'/.test_rw';
  var authHeaders=auth?{'Authorization':auth}:{};
  var putHeaders=Object.assign({'Content-Type':'application/json'},authHeaders);
  var doPut=function(){
    return fetch(testFilePath,{method:'PUT',headers:putHeaders,body:JSON.stringify({test:Date.now()})});
  };
  /* 乐观写入：目录存在时直接写入；若返回 409/404（父目录不存在）才补发 MKCOL 并重试 */
  doPut().then(function(putResp){
    if(putResp&&(putResp.status===409||putResp.status===404)){
      return fetch(easyduPath,{method:'MKCOL',headers:authHeaders}).catch(function(){}).then(function(){
        return doPut();
      });
    }
    return putResp;
  }).then(function(putResp){
    var writeOk=(putResp&&putResp.ok);
    if(writeOk){
      _davDirEnsured=true;
      /* 清理测试文件 */
      fetch(testFilePath,{method:'DELETE',headers:authHeaders}).catch(function(){});
    }
    /* 保存凭据 */
    var saveUrl=(webdavCfgUrl?webdavCfgUrl.value.trim():'')||origin+path;
    saveWebDAVCredentials(saveUrl,user,pass,function(){
      webdavBaseUrl=origin;
      webdavMountPath=path;
      webdavCurrentPath=path;
      webdavAuth=auth;
      if(writeOk){
        updateStatusUI('connected','连接成功！WebDAV 读写权限正常，已自动保存配置。',false);
      }else{
        updateStatusUI('readonly','只读连接成功（无写入权限，远端进度同步将受限）。已保存配置。',false);
      }
      window.toast('WebDAV 配置已保存');
      setTimeout(syncRemoteCatsIfAvailable,500);
    });
  }).catch(function(){
    var saveUrl=(webdavCfgUrl?webdavCfgUrl.value.trim():'')||origin+path;
    saveWebDAVCredentials(saveUrl,user,pass,function(){
      webdavBaseUrl=origin;
      webdavMountPath=path;
      webdavCurrentPath=path;
      webdavAuth=auth;
      updateStatusUI('connected','连接成功，配置已保存。',false);
      window.toast('WebDAV 配置已保存');
      setTimeout(syncRemoteCatsIfAvailable,500);
    });
  });
}

/* ===== 清除配置 ===== */
function handleClearConfig(){
  window.confirmBox('确定要清除 WebDAV 配置并断开连接吗？','清除配置',function(){
    try{localStorage.removeItem('jd_webdav')}catch(e){}
    webdavBaseUrl='';
    webdavMountPath='/';
    webdavCurrentPath='/';
    webdavAuth='';
    _davDirEnsured=false;
    if(webdavCfgUrl)webdavCfgUrl.value='';
    if(webdavCfgUser)webdavCfgUser.value='';
    if(webdavCfgPass)webdavCfgPass.value='';
    updateStatusUI('unconfigured','已清除 WebDAV 配置',false);
    window.toast('WebDAV 配置已清除');
  });
}

/* ===== 模态框交互与焦点陷阱 ===== */
function showWebDAVModal(){
  if(!isConfigured()){
    window.toast('请先在设置中配置 WebDAV');
    if(window.showBookshelfSettings)window.showBookshelfSettings();
    if(webdavSettingsFold)webdavSettingsFold.open=true;
    return;
  }
  webdavLastFocus=document.activeElement;
  webdavModalTitle.textContent='WebDAV 远程导入';
  webdavModal.classList.add('show');
  webdavModal.setAttribute('aria-hidden','false');
  webdavCurrentPath=webdavMountPath||'/';
  syncRemoteCatsIfAvailable();
  webdavListDir(webdavCurrentPath);
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){
      if(webdavModal.classList.contains('show')){
        var refBtn=$('webdav-refresh');
        if(refBtn)refBtn.focus();
      }
    });
  });
}
function hideWebDAVModal(){
  webdavModal.classList.remove('show');
  webdavModal.setAttribute('aria-hidden','true');
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

/* ===== 目录浏览与文件列表 ===== */
function webdavListDir(path){
  webdavCurrentPath=path||webdavMountPath||'/';
  webdavFileList.innerHTML='<div class="webdav-loading">加载中...</div>';
  renderBreadcrumb();
  webdavPropfind(webdavCurrentPath,'1').then(function(resp){
    if(!resp.ok&&resp.status!==207){
      if(resp.status===401){
        window.toast('认证失败，请在设置中检查 WebDAV 账号密码');
        webdavFileList.innerHTML='<div class="webdav-empty">认证失败 (401)，请在书架设置中检查账号密码</div>';
        return;
      }
      throw new Error('请求失败: HTTP '+resp.status);
    }
    return resp.text();
  }).then(function(xml){
    if(!xml)return;
    var items=webdavParseResponse(xml);
    var parentClean=webdavCurrentPath.replace(/\/$/,'');
    var currentItems=items.filter(function(item){
      var itemClean=item.href.replace(/\/$/,'');
      if(itemClean===parentClean)return false;
      if(item.name&&item.name.startsWith('.'))return false; /* 过滤 .easydu 等系统目录与隐藏文件 */
      if(!itemClean.startsWith(parentClean+'/'))return false;
      var sub=itemClean.slice(parentClean.length+1);
      return!sub.includes('/');
    });
    currentItems.sort(function(a,b){
      if(a.isFolder!==b.isFolder)return a.isFolder?-1:1;
      return a.name.localeCompare(b.name,'zh-Hans-CN');
    });
    renderFileList(currentItems);
  }).catch(function(err){
    webdavFileList.innerHTML='<div class="webdav-empty">加载失败: '+err.message+'</div>';
  });
}

function renderBreadcrumb(){
  webdavBreadcrumb.innerHTML='';
  var mountClean=(webdavMountPath||'/').replace(/\/$/,'');
  var currentClean=(webdavCurrentPath||'/').replace(/\/$/,'');

  var homeItem=document.createElement('span');
  homeItem.className='webdav-breadcrumb-item'+(currentClean===mountClean?' current':'');
  homeItem.textContent='根目录';
  homeItem.onclick=function(){
    if(currentClean!==mountClean)webdavListDir(webdavMountPath||'/');
  };
  webdavBreadcrumb.appendChild(homeItem);

  if(currentClean.startsWith(mountClean)){
    var sub=currentClean.slice(mountClean.length).replace(/^\//,'');
    if(sub){
      var parts=sub.split('/').filter(Boolean);
      var accum=mountClean;
      for(var i=0;i<parts.length;i++){
        accum+='/'+parts[i];
        var sep=document.createElement('span');
        sep.textContent='›';
        sep.style.color='var(--text-sec)';
        webdavBreadcrumb.appendChild(sep);
        var item=document.createElement('span');
        var isLast=(i===parts.length-1);
        item.className='webdav-breadcrumb-item'+(isLast?' current':'');
        item.textContent=parts[i];
        if(!isLast){
          (function(p){
            item.onclick=function(){webdavListDir(p)};
          })(accum);
        }
        webdavBreadcrumb.appendChild(item);
      }
    }
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
    icon.innerHTML=item.isFolder
      ?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>'
      :'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>';
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
      div.onclick=function(){webdavListDir(item.href.replace(/\/$/,''))};
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
  webdavFetch(item.href).then(function(resp){
    if(!resp.ok)throw new Error('下载失败: HTTP '+resp.status);
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
        function checkRemoteAfterImport(fname){
          if(!window.davSyncAvailable||!window.davSyncAvailable())return;
          window.davDownloadCheckpoint(fname,function(remote){
            if(!remote)return;
            if((remote.bm&&remote.bm.length)||(remote.delBm&&remote.delBm.length)){
              try{
                var curBm=JSON.parse(localStorage.getItem('jd_bm_'+fname)||'[]');
                var mergedBm=window.mergeBookmarks(fname,curBm,remote.bm||[],remote.delBm||[]);
                localStorage.setItem('jd_bm_'+fname,JSON.stringify(mergedBm));
              }catch(e){}
            }
            if((remote.ant&&remote.ant.length)||(remote.delAnt&&remote.delAnt.length)){
              try{
                var curAnt=JSON.parse(localStorage.getItem('jd_ant_'+fname)||'[]');
                var mergedAnt=window.mergeAnnotations(fname,curAnt,remote.ant||[],remote.delAnt||[]);
                localStorage.setItem('jd_ant_'+fname,JSON.stringify(mergedAnt));
              }catch(e){}
            }
            if((remote.hl&&remote.hl.length)||(remote.delHl&&remote.delHl.length)){
              try{
                var curHl=JSON.parse(localStorage.getItem('jd_hl_'+fname)||'[]');
                var mergedHl=window.mergeHlList(fname,curHl,remote.hl||[],remote.delHl||[]);
                localStorage.setItem('jd_hl_'+fname,JSON.stringify(mergedHl));
              }catch(e){}
            }
            if((remote.rep&&remote.rep.length)||(remote.delRep&&remote.delRep.length)){
              try{
                var curRep=JSON.parse(localStorage.getItem('jd_rep_'+fname)||'[]');
                var mergedRep=window.mergeRepRules(fname,curRep,remote.rep||[],remote.delRep||[]);
                localStorage.setItem('jd_rep_'+fname,JSON.stringify(mergedRep));
              }catch(e){}
            }
            if(remote.cat!==undefined){
              var lib=window.getLib?window.getLib():[];
              var cChanged=false;
              for(var li=0;li<lib.length;li++){
                if(lib[li].n===fname){
                  if(lib[li].cat!==remote.cat){
                    lib[li].cat=remote.cat;
                    cChanged=true;
                  }
                  break;
                }
              }
              if(cChanged){
                if(window.saveLib)window.saveLib(lib);
                if(window.renderBookshelf)window.renderBookshelf();
              }
            }
            if(remote.cats&&Array.isArray(remote.cats)&&window.mergeCats){
              window.mergeCats(remote.cats);
            }else if(remote.cat&&window.mergeCats){
              window.mergeCats([{n:remote.cat}]);
            }
            if(window.S&&window.S.fileName===fname){
              if(window.clearBookCache)window.clearBookCache();
              if(window.renderBookmarks)window.renderBookmarks();
              if(window.renderAnnotations)window.renderAnnotations();
              if(window.renderHlList)window.renderHlList();
              if(window.renderRepList)window.renderRepList();
              if(window.updateRepSwitch)window.updateRepSwitch();
              if(window.rerenderCurrent)window.rerenderCurrent();
            }
            if(remote.prog){
              var localProg=window.loadProg?window.loadProg(fname):null;
              if(!localProg){
                if(window.davApplyRemoteData)window.davApplyRemoteData(fname,remote);
                if((remote.prog.ch>0||remote.prog.offset>0)&&window.J){
                  setTimeout(function(){
                    window.J.go(remote.prog.ch||0,Math.max(0,remote.prog.offset||0));
                  },500);
                }
              }else if(window.davRemoteAhead&&window.davRemoteAhead(localProg,remote.prog)){
                setTimeout(function(){
                  window.confirmBox('检测到远端进度（第'+(remote.prog.ch+1)+'章 '+Math.round(remote.prog.pct||0)+'%），是否跳转？','跳转到远端进度',function(){
                    if(window.davApplyRemoteData)window.davApplyRemoteData(fname,remote);
                    setTimeout(function(){
                      var np=window.loadProg?window.loadProg(fname):null;
                      if(np&&window.J){
                        window.J.go(np.ch||0,Math.max(0,np.offset||0));
                      }
                    },500);
                  });
                },1000);
              }
            }
          });
        }
        if(ext==='epub'){
          window.parseEPUB(buf,function(result,err){
            if(err||!result){window.hideLoading();window.toast('EPUB 解析失败: '+(err||'未知错误'));return}
            window.finishEpubImport(item.name,item.size,result,source,'webdav');
            checkRemoteAfterImport(item.name);
          });
        }else{
          window.S.rawText=window.decodeBuffer(buf);
          var cv=window.generateCoverDataUrl(item.name);
          window.addToLib(window.S.fileName,window.S.fileSize,window.S.fileType,cv,'webdav');
          window.dbSave(window.S.fileName,{text:window.S.rawText,type:window.S.fileType,size:window.S.fileSize,cover:cv},function(){});
          window.processContent();
          checkRemoteAfterImport(window.S.fileName);
        }
      }catch(err){console.error(err);window.toast('文件解析失败: '+err.message);window.hideLoading()}
    },window.PROC_DELAY);
  }).catch(function(err){
    window.hideLoading();
    window.toast('下载失败: '+err.message);
  });
}

/* ===== 事件绑定 ===== */
on($('import-webdav'),'click',function(e){
  e.stopPropagation();
  if(importDropdownMenu)importDropdownMenu.classList.remove('show');
  showWebDAVModal();
});
on(document,'mousedown',function(e){
  if(webdavModal.classList.contains('show')&&!e.target.closest('.webdav-modal-content')){
    hideWebDAVModal();
  }
});
on($('webdav-modal-close'),'click',hideWebDAVModal);
on($('webdav-refresh'),'click',function(){webdavListDir(webdavCurrentPath)});
on($('webdav-back'),'click',function(){
  var mountClean=(webdavMountPath||'/').replace(/\/$/,'');
  var currentClean=(webdavCurrentPath||'/').replace(/\/$/,'');
  if(currentClean===mountClean)return;
  var idx=currentClean.lastIndexOf('/');
  var parent=(idx>0)?currentClean.slice(0,idx):'/';
  if(parent.length<mountClean.length)parent=mountClean||'/';
  webdavListDir(parent);
});
on(webdavCfgSave,'click',handleSaveAndTest);
on(webdavCfgClear,'click',handleClearConfig);
on(webdavCfgUrl,'keydown',function(e){if(e.key==='Enter'){e.preventDefault();handleSaveAndTest()}});
on(webdavCfgPass,'keydown',function(e){if(e.key==='Enter'){e.preventDefault();handleSaveAndTest()}});

/* ===== 配置同步：.easydu 隐藏目录（checkpoint 模式） ===== */
/* 书籍进度配置 -> <WebDAV挂载根目录>/.easydu/<encodeURIComponent(书名)>.json */
function davSyncBasePath(){return(webdavMountPath||'/').replace(/\/$/,'')+'/.easydu'}
function davSyncBookPath(name){return davSyncBasePath()+'/'+encodeURIComponent(name)+'.json'}
function davSyncEnabled(){return!!webdavBaseUrl}
function davSyncPut(path,data,opts){
  var o=Object.assign({method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)},opts||{});
  return webdavFetch(path,o);
}
function davSyncGet(path){
  return webdavFetch(path).then(function(resp){
    if(resp.status===404)return{ok:true,data:null};
    if(!resp.ok)return{ok:false,error:'HTTP '+resp.status};
    return resp.json().then(function(d){return{ok:true,data:d}}).catch(function(){return{ok:true,data:null}});
  }).catch(function(e){return{ok:false,error:String(e&&e.message||e)}});
}
var _davDirEnsured=false;
function davSyncEnsureDir(){
  if(_davDirEnsured)return Promise.resolve();
  return webdavFetch(davSyncBasePath(),{method:'MKCOL'}).then(function(r){
    if(r.ok||r.status===405||r.status===409)_davDirEnsured=true;
    return r;
  }).catch(function(e){return{ok:false,status:0,error:e}});
}
function davSyncSaveBook(name,payload,opts){
  var path=davSyncBookPath(name);
  /* 乐观 PUT：日常同步直接 PUT 写入配置；若遇 409/404（父目录未建）才补发 MKCOL 并重试，避免每次会话产生 MKCOL 405 红字 */
  return davSyncPut(path,payload,opts).then(function(resp){
    if(resp&&(resp.status===409||resp.status===404)&&!_davDirEnsured){
      return davSyncEnsureDir().then(function(){
        return davSyncPut(path,payload,opts);
      });
    }
    if(resp&&resp.ok)_davDirEnsured=true;
    return resp;
  });
}
function davSyncLoadBook(name){return davSyncGet(davSyncBookPath(name))}
function davSyncDeleteBook(name){return davSyncDelete(davSyncBookPath(name))}

/* 全局书籍标签同步 -> <WebDAV挂载根目录>/.easydu/cats.json */
function davSyncCatsPath(){return davSyncBasePath()+'/cats.json'}
function davSyncSaveCats(cats,opts){
  var path=davSyncCatsPath();
  return davSyncPut(path,cats,opts).then(function(resp){
    if(resp&&(resp.status===409||resp.status===404)&&!_davDirEnsured){
      return davSyncEnsureDir().then(function(){
        return davSyncPut(path,cats,opts);
      });
    }
    if(resp&&resp.ok)_davDirEnsured=true;
    return resp;
  });
}
function davSyncLoadCats(){return davSyncGet(davSyncCatsPath())}
function syncRemoteCatsIfAvailable(){
  if(!davSyncEnabled())return;
  davSyncLoadCats().then(function(r){
    if(r&&r.ok&&r.data&&Array.isArray(r.data)&&window.mergeCats){
      window.mergeCats(r.data);
    }
  }).catch(function(){});
}

/* ===== 启动初始化 ===== */
initWebDAVOnBoot();

/* ===== 模块导出 ===== */
window.WebDAV={
  isOpen:function(){return webdavModal.classList.contains('show')},
  hide:hideWebDAVModal,
  trapFocus:trapWebDAVFocus,
  isConfigured:isConfigured,
  syncEnabled:davSyncEnabled,
  syncSaveBook:davSyncSaveBook,
  syncLoadBook:davSyncLoadBook,
  syncDeleteBook:davSyncDeleteBook,
  syncSaveCats:davSyncSaveCats,
  syncLoadCats:davSyncLoadCats,
  syncRemoteCats:syncRemoteCatsIfAvailable
};
})();
