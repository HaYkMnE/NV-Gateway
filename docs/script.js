(function(){
var d=document,live=d.getElementById("live");
function say(t){if(!live)return;live.textContent="";setTimeout(function(){live.textContent=t},30)}
d.addEventListener("click",function(e){
var b=e.target.closest("[data-copy]");if(!b)return;
var c=b.parentNode.querySelector("code"),s=b.querySelector("span"),o=s.textContent;
function done(ok){var m=ok?live.dataset.ok:live.dataset.err;s.textContent=m;say(m);setTimeout(function(){s.textContent=o},1600)}
if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(c.textContent).then(function(){done(true)},function(){done(false)})}
else{var r=d.createRange();r.selectNodeContents(c);var g=getSelection();g.removeAllRanges();g.addRange(r);var ok=false;try{ok=d.execCommand("copy")}catch(x){}g.removeAllRanges();done(ok)}
});
var mn=d.querySelector("details.menu");
if(mn){mn.addEventListener("click",function(e){if(e.target.closest("a"))mn.open=false});
d.addEventListener("keydown",function(e){if(e.key==="Escape"&&mn.open){mn.open=false;mn.querySelector("summary").focus()}})}
var l=d.querySelector("[data-lang]");
if(l)l.addEventListener("click",function(){if(location.hash)l.href=l.getAttribute("href").split("#")[0]+location.hash});
var bar=d.querySelector(".bar"),st=d.getElementById("sticky"),h=d.getElementById("hero-cta");
if(bar)addEventListener("scroll",function(){bar.classList.toggle("scrolled",scrollY>8)},{passive:true});
if(h&&st&&"IntersectionObserver"in window){
new IntersectionObserver(function(en){var past=!en[0].isIntersecting&&en[0].boundingClientRect.top<0;
st.classList.toggle("on",past);st.inert=!past;bar.classList.toggle("cta-on",past)}).observe(h)}
})();
