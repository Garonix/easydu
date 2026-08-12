/* epub.js — EPUB 解析模块（自 script.js 拆分）
 * 职责: 解包 EPUB zip、提取章节/封面/TOC（NCX + NAV）、内联图片、
 *       CSS 字体转 base64、CSS 规则作用域化、章节 href 匹配
 * 依赖: JSZip（index.html 中全局加载）、window.S（章节列表，findChapterByHref 使用）
 * 导出: window.EPUB = { parseEPUB, hrefMatch, findChapterByHref }
 */
(function(){
'use strict';
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
  var chapters=(window.S&&window.S.chapters)||[];
  for(var i=0;i<chapters.length;i++){
    if(hrefMatch(chapters[i].href||'',base))return i;
  }
  return -1;
}
window.EPUB={
  parseEPUB:parseEPUB,
  hrefMatch:hrefMatch,
  findChapterByHref:findChapterByHref
};
})();
