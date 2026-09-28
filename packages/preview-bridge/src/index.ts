/**
 * The preview bridge runs inside the sandboxed preview iframe. The management
 * server injects it into the served HTML at request time; it is never written to
 * a design source file. When the user clicks an element in Select mode, the bridge
 * reports a selection to the canvas shell with `postMessage`. The shell is
 * responsible for validating the message source, screen id, and per-frame nonce
 * before trusting it — a sandboxed frame can present an opaque origin, so origin
 * alone is not sufficient.
 */
export type BridgeConfig = {
  projectId: string;
  screenId: string;
  nonce: string;
};

export type SelectionMessage = {
  source: 'local-design-canvas';
  kind: 'selection';
  nonce: string;
  projectId: string;
  screenId: string;
  elementId: string | null;
  selector: string;
  text: string;
  bounds: { x: number; y: number; width: number; height: number };
};

export function cssEscape(value: string): string {
  const api = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
  if (api?.escape) return api.escape(value);
  return value.replace(/["\\\]]/g, '\\$&');
}

export function cssSelectorFor(element: Element): string {
  const designId = element.getAttribute('data-design-id');
  if (designId) return `[data-design-id="${cssEscape(designId)}"]`;
  const segments: string[] = [];
  let current: Element | null = element;
  while (current && current.nodeType === 1 && segments.length < 5) {
    if (current.id) {
      segments.unshift(`#${cssEscape(current.id)}`);
      break;
    }
    let segment = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((child) => child.tagName === current!.tagName);
      if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    segments.unshift(segment);
    current = current.parentElement;
  }
  return segments.join(' > ') || element.tagName.toLowerCase();
}

export function createSelectionMessage(config: BridgeConfig, element: Element): SelectionMessage {
  const rect = element.getBoundingClientRect();
  return {
    source: 'local-design-canvas',
    kind: 'selection',
    nonce: config.nonce,
    projectId: config.projectId,
    screenId: config.screenId,
    elementId: element.getAttribute('data-design-id'),
    selector: cssSelectorFor(element),
    text: (element.textContent ?? '').trim().slice(0, 240),
    bounds: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

/**
 * Hand-authored script string injected into preview HTML as
 * `<script>${bridgeScriptSource(config)}</script>`. It is intentionally written as a
 * plain string rather than serialized from a TypeScript function: bundlers (esbuild,
 * tsx) rewrite named functions with helper references like `__name`, which are not
 * defined inside the sandboxed iframe and would throw. The config is embedded as
 * JSON data, not as executable code.
 */
/**
 * Reports the preview document's intrinsic height so the canvas frame can grow
 * to the full page. The frame then behaves like a Figma artboard: the whole
 * screen is visible and the canvas pans/zooms, instead of scrolling inside the
 * iframe. Config is JSON data, not executable code. Overflow is locked after
 * measuring so a short page cannot show a scrollbar from the default body margin.
 */
export function contentSizeScriptSource(config: { screenId: string }): string {
  const serialized = JSON.stringify(config);
  return `(function(config){
  var last=0, posts=0;
  function heightOf(){
    var body=document.body;
    if(!body)return 0;
    var max=0, children=body.children;
    for(var i=0;i<children.length;i++){
      var node=children[i], tag=node.tagName;
      if(tag==="SCRIPT"||tag==="STYLE")continue;
      var rect=node.getBoundingClientRect();
      var style=getComputedStyle(node);
      var bottom=rect.bottom+window.scrollY+(parseFloat(style.marginBottom)||0);
      if(bottom>max)max=bottom;
    }
    var bodyStyle=getComputedStyle(body);
    var extra=(parseFloat(bodyStyle.paddingBottom)||0)+(parseFloat(bodyStyle.marginTop)||0)+(parseFloat(bodyStyle.marginBottom)||0);
    return Math.ceil(max+extra);
  }
  function publish(){
    if(posts>=12)return;
    var height=heightOf();
    if(height<1||height>16384||Math.abs(height-last)<2)return;
    last=height; posts+=1;
    if(window.parent&&window.parent!==window){
      window.parent.postMessage({source:"local-design-canvas",kind:"content-size",screenId:config.screenId,height:height},"*");
    }
  }
  function start(){
    var doc=document.documentElement;
    if(doc)doc.style.overflow="hidden";
    if(document.body)document.body.style.overflow="hidden";
    publish();
    window.addEventListener("load",publish);
    if(document.fonts&&document.fonts.ready)document.fonts.ready.then(publish);
    if(window.ResizeObserver&&document.body)new ResizeObserver(publish).observe(document.body);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);
  else start();
})(${serialized});`;
}

export function bridgeScriptSource(config: BridgeConfig): string {
  const serialized = JSON.stringify(config);
  return `(function(config){
  function escape(value){var api=window.CSS;return api&&api.escape?api.escape(value):value.replace(/["\\\\\\]]/g,"\\\\$&");}
  function selectorFor(element){
    var designId=element.getAttribute("data-design-id");
    if(designId)return '[data-design-id="'+escape(designId)+'"]';
    var segments=[];var current=element;
    while(current&&current.nodeType===1&&segments.length<5){
      if(current.id){segments.unshift("#"+escape(current.id));break;}
      var segment=current.tagName.toLowerCase();var parent=current.parentElement;
      if(parent){var kin=Array.prototype.filter.call(parent.children,function(child){return child.tagName===current.tagName;});if(kin.length>1)segment+=":nth-of-type("+(kin.indexOf(current)+1)+")";}
      segments.unshift(segment);current=current.parentElement;
    }
    return segments.join(" > ")||element.tagName.toLowerCase();
  }
  document.addEventListener("pointermove",function(event){
    var target=event.target;
    if(target&&target.nodeType!==1)target=target.parentElement;
    if(!target||target.nodeType!==1||!window.parent||window.parent===window)return;
    var rect=target.getBoundingClientRect();
    window.parent.postMessage({source:"local-design-canvas",kind:"hover",nonce:config.nonce,projectId:config.projectId,screenId:config.screenId,elementId:target.getAttribute("data-design-id"),selector:selectorFor(target),text:(target.textContent||"").trim().slice(0,240),bounds:{x:Math.round(rect.left),y:Math.round(rect.top),width:Math.round(rect.width),height:Math.round(rect.height)}},"*");
  },true);
  document.addEventListener("pointerdown",function(event){
    var target=event.target;
    // Clicking text usually produces a Text node as event.target. Promote it
    // to its containing element so text, labels, and nested content remain
    // selectable instead of being silently ignored.
    if(target&&target.nodeType!==1)target=target.parentElement;
    if(!target||target.nodeType!==1)return;
    if(!window.parent||window.parent===window)return;
    if(event.button!==0)return;
    event.preventDefault();event.stopPropagation();
    var rect=target.getBoundingClientRect();
    window.parent.postMessage({
      source:"local-design-canvas",kind:"selection",
      nonce:config.nonce,projectId:config.projectId,screenId:config.screenId,
      elementId:target.getAttribute("data-design-id"),
      selector:selectorFor(target),
      text:(target.textContent||"").trim().slice(0,240),
      bounds:{x:Math.round(rect.left),y:Math.round(rect.top),width:Math.round(rect.width),height:Math.round(rect.height)}
    },"*");
  },true);
})(${serialized});`;
}

/** Capture bridge used by the Figma HTML-to-design runtime. */
export function figmaCaptureScriptSource(config: { screenId: string }): string {
  const serialized = JSON.stringify(config);
  return `(function(config){
  var host=window.parent, active=null, loaded;
  function notify(data){host.postMessage(Object.assign({source:"local-design-canvas",kind:"figma-capture",screenId:config.screenId},data),"*");}
  function load(){
    if(loaded)return loaded;
    loaded=new Promise(function(resolve,reject){
      var script=document.createElement("script");
      script.src="https://mcp.figma.com/mcp/html-to-design/capture.js";
      script.onload=function(){resolve()}; script.onerror=function(){reject(new Error("Figma capture runtime kon tải được."))};
      document.head.appendChild(script);
    }).catch(function(error){loaded=undefined;throw error});
    return loaded;
  }
  function hideRuntimeUi(){
    if(document.getElementById("local-canvas-figma-capture-ui"))return;
    var style=document.createElement("style");
    style.id="local-canvas-figma-capture-ui";
    style.textContent="#__figma_capture_toolbar_host__{display:none!important}";
    document.head.appendChild(style);
  }
  window.addEventListener("message",function(event){
    if(event.source!==host)return;
    var data=event.data;
    if(!data||data.source!=="local-design-canvas"||data.kind!=="figma-capture-start"||typeof data.requestId!=="string")return;
    if(active){notify({requestId:data.requestId,ok:false,message:"Đang có capture khác."});return}
    active=data.requestId;
    try{window.focus()}catch(_){}
    hideRuntimeUi();
    var original=navigator.clipboard&&navigator.clipboard.write;
    if(!navigator.clipboard||!original){notify({requestId:active,ok:false,message:"Preview không hỗ trợ clipboard."});active=null;return}
    Object.defineProperty(navigator.clipboard,"write",{configurable:true,value:async function(items){
      var item=items.find(function(candidate){return candidate.types.includes("text/html")});
      if(!item||active===null)throw new Error("Figma runtime không trả về HTML clipboard.");
      var html=await (await item.getType("text/html")).text();
      notify({requestId:active,ok:true,html:html});
      return new Promise(function(resolve,reject){window.__h2fClipboard={resolve:resolve,reject:reject}});
    }});
    load().then(function(){
      var figma=window.figma;
      if(!figma||!figma.captureForDesign)throw new Error("Figma capture runtime không sẵn sàng.");
      return figma.captureForDesign({selector:"body"});
    }).then(function(result){
      if(!result.success)throw new Error(result.error||"Figma capture thất bại.");
    }).catch(function(error){notify({requestId:active,ok:false,message:error&&error.message||String(error)});active=null});
  });
  window.addEventListener("message",function(event){
    if(event.source!==host)return; var data=event.data;
    if(!data||data.source!=="local-design-canvas"||data.kind!=="figma-capture-result")return;
    var pending=window.__h2fClipboard; window.__h2fClipboard=undefined;
    if(pending)(data.ok?pending.resolve:pending.reject)(data.ok?undefined:new Error(data.message||"Clipboard bị từ chối."));
    active=null;
  });
})(${serialized});`;
}
