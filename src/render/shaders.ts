// GLSL ES 3.0 shader sources.

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main(){ v_uv = a_pos*0.5+0.5; gl_Position = vec4(a_pos,0.0,1.0); }`;

// Space backdrop: nebula fbm + parallax star layers + map boundary.
export const BG_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform vec2 u_cam; uniform float u_zoom; uniform vec2 u_res; uniform float u_time; uniform float u_size;
float h21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),u.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x), u.y); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*noise(p); p=p*2.03+vec2(17.1,9.3); a*=0.5; } return s; }
vec3 stars(vec2 p, float density, float size){
  vec2 c=floor(p), f=fract(p)-0.5;
  float r=h21(c);
  if(r>density) return vec3(0);
  vec2 off=vec2(h21(c+3.1),h21(c+7.7))-0.5;
  float d=length(f-off*0.7);
  float tw=0.7+0.3*sin(u_time*(1.0+r*3.0)+r*40.0);
  float b=smoothstep(size,0.0,d)*tw;
  vec3 col=mix(vec3(0.7,0.8,1.0),vec3(1.0,0.85,0.7),h21(c+1.3));
  return col*b;
}
void main(){
  vec2 px=(v_uv-0.5)*u_res;
  vec2 world=u_cam+vec2(px.x,-px.y)/u_zoom;
  // Parallax layers move slower than the world.
  vec2 far=(u_cam*0.15+vec2(px.x,-px.y)/max(u_zoom,0.08)*0.5)/700.0;
  float n=fbm(far*1.3+vec2(0.0,u_time*0.004));
  float n2=fbm(far*2.7-vec2(u_time*0.003,0.0)+n*1.5);
  vec3 col=vec3(0.010,0.012,0.028);
  col+=vec3(0.05,0.02,0.10)*smoothstep(0.35,0.85,n)*1.4;
  col+=vec3(0.00,0.06,0.09)*smoothstep(0.45,0.9,n2)*1.3;
  col+=vec3(0.09,0.03,0.05)*smoothstep(0.6,0.95,n*n2*1.6);
  vec2 sp=(u_cam*0.3+vec2(px.x,-px.y)/max(u_zoom,0.1)*0.6);
  col+=stars(sp/38.0,0.10,0.10)*0.6;
  col+=stars((u_cam*0.6+vec2(px.x,-px.y)/max(u_zoom,0.1)*0.85)/70.0+31.0,0.06,0.07)*0.9;
  // Subtle world grid that fades when zoomed out.
  vec2 g=abs(fract(world/400.0)-0.5);
  float line=smoothstep(0.5-1.2/(u_zoom*400.0),0.5,max(g.x,g.y));
  col+=vec3(0.03,0.05,0.08)*line*clamp(u_zoom*1.5,0.0,1.0);
  // Map boundary.
  vec2 e=min(world,vec2(u_size)-world);
  float edge=min(e.x,e.y);
  col+=vec3(0.2,0.35,0.6)*exp(-abs(edge)*u_zoom*0.25)*0.5;
  if(edge<0.0) col*=0.35;
  o=vec4(col,1.0);
}`;

// Instanced sprite: every visible thing is a quad with an SDF shape.
export const SPRITE_VS = /* glsl */ `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_posAxis;   // x, y, axisX, axisY
layout(location=2) in vec2 a_wShape;    // half width, shape id
layout(location=3) in vec4 a_color;
layout(location=4) in vec2 a_param;
uniform vec2 u_cam; uniform float u_zoom; uniform vec2 u_res;
out vec2 v_uv; out vec4 v_color; out vec2 v_param; out vec2 v_dim; flat out int v_shape;
void main(){
  vec2 axis=a_posAxis.zw;
  float len=length(axis);
  vec2 dir=len>1e-4?axis/len:vec2(1,0);
  float w=a_wShape.x;
  float L=max(len,w);
  vec2 perp=vec2(-dir.y,dir.x);
  vec2 world=a_posAxis.xy+dir*a_corner.x*L+perp*a_corner.y*w;
  vec2 ndc=(world-u_cam)*u_zoom/(u_res*0.5);
  ndc.y=-ndc.y; // world y grows downward like the screen
  gl_Position=vec4(ndc,0.0,1.0);
  v_uv=a_corner; v_color=a_color; v_param=a_param; v_dim=vec2(L,w); v_shape=int(a_wShape.y+0.5);
}`;

export const SPRITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv; in vec4 v_color; in vec2 v_param; in vec2 v_dim; flat in int v_shape;
out vec4 o;
uniform float u_time;
float h11(float p){ return fract(sin(p*127.1)*43758.5453); }
float vnoise(float x, float s){ float i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f); return mix(h11(i+s),h11(i+1.0+s),f); }
float sdSeg(vec2 p, float L){ p.x=abs(p.x); p.x=max(p.x-L,0.0); return length(p); }
float sdTri(vec2 p){ // isoceles pointing +x, in [-1,1]
  p.y=abs(p.y);
  vec2 a=vec2(1.0,0.0), b=vec2(-0.8,0.75);
  vec2 n=normalize(vec2(b.y-a.y,a.x-b.x));
  return max(dot(p-a,n), -0.8-p.x);
}
float sdBox(vec2 p, vec2 b){ vec2 d=abs(p)-b; return length(max(d,0.0))+min(max(d.x,d.y),0.0); }
float sdHex(vec2 p, float r){ const vec3 k=vec3(-0.866025404,0.5,0.577350269); p=abs(p); p-=2.0*min(dot(k.xy,p),0.0)*k.xy; p-=vec2(clamp(p.x,-k.z*r,k.z*r),r); return length(p)*sign(p.y); }
void main(){
  vec2 p=v_uv*v_dim; // local units
  float w=v_dim.y;
  vec4 c=v_color;
  if(v_shape==0){ // glowing streak (units, sparks)
    float d=sdSeg(p,v_dim.x-w)/w;
    float core=smoothstep(0.42,0.18,d);
    float glow=exp(-d*d*5.0)*0.55;
    float a=core+glow;
    o=vec4(c.rgb*a*c.a + vec3(core*0.35*c.a),0.0);
    return;
  }
  if(v_shape==1){ // ring, param.x = thickness 0..1
    float r=length(v_uv);
    float th=max(v_param.x,0.02);
    float d=abs(r-(1.0-th*0.5))/(th*0.5);
    float a=smoothstep(1.0,0.0,d);
    a+=exp(-d*d*0.6)*0.25;
    if(r>1.0) a*=smoothstep(1.05,1.0,r);
    o=vec4(c.rgb*a*c.a, 0.0);
    return;
  }
  if(v_shape==2){ // soft disk
    float r=length(v_uv);
    float a=max(0.0,1.0-r*r); a*=a;
    o=vec4(c.rgb*a*c.a, 0.0);
    return;
  }
  if(v_shape==3){ // ship hull, param.x = type, param.y = flash. alpha blended.
    vec2 q=v_uv;
    float d;
    int t=int(v_param.x+0.5);
    if(t==0){ d=sdTri(q*vec2(1.0,1.6)); }
    else if(t==1){ d=min(sdTri(q*vec2(1.25,1.0)+vec2(0.15,0.0)), sdBox(q-vec2(-0.3,0.0),vec2(0.25,0.85))); }
    else if(t==2){ d=sdHex(q,0.78); }
    else { d=min(sdBox(q,vec2(0.9,0.32)), sdBox(q-vec2(0.4,0.0),vec2(0.55,0.55))); d=max(d,-sdBox(q-vec2(0.85,0.0),vec2(0.3,0.12))); }
    float aa=fwidth(d)*1.5;
    float fill=smoothstep(aa,-aa,d);
    float rim=smoothstep(0.09,0.0,abs(d+0.06));
    float panel=step(0.5,fract((q.x+q.y*0.5)*4.0))*0.05;
    vec3 body=vec3(0.06,0.05,0.07)+panel+c.rgb*0.08;
    vec3 col=mix(body,c.rgb*1.6,rim);
    col=mix(col,vec3(1.0),v_param.y*0.7);
    // engine glow at the back
    float eng=exp(-pow(length(q-vec2(-0.85,0.0))*3.0,2.0))*(0.6+0.4*sin(u_time*30.0));
    col+=c.rgb*eng*1.5;
    float a=max(fill, eng*0.8);
    o=vec4(col*a,a);
    return;
  }
  if(v_shape==4){ // rock, param.x = seed, param.y = wreck flag. alpha blended.
    float ang=atan(v_uv.y,v_uv.x);
    float r=length(v_uv);
    float s=v_param.x;
    float edge=0.8+0.1*vnoise(ang*1.6+3.0,s)+0.07*vnoise(ang*4.0,s+5.0)+0.03*vnoise(ang*11.0,s+9.0);
    float d=r-edge;
    float aa=fwidth(r)*1.5;
    float fill=smoothstep(aa,-aa,d);
    vec2 n2=v_uv/edge;
    float z=sqrt(max(0.0,1.0-dot(n2,n2)));
    vec3 n=normalize(vec3(n2*0.9,z));
    vec3 L=normalize(vec3(-0.5,0.6,0.65));
    float lit=clamp(dot(n,L),0.0,1.0);
    float crater=vnoise(v_uv.x*7.0+s,s)*vnoise(v_uv.y*7.0-s,s+2.0);
    vec3 base=v_param.y>0.5? vec3(0.32,0.28,0.25) : vec3(0.30,0.26,0.24);
    vec3 col=base*(0.18+lit*0.95)*(0.8+crater*0.4);
    if(v_param.y>0.5){ col+=vec3(1.0,0.5,0.15)*smoothstep(0.75,0.95,crater)*0.8; }
    // mineral veins that glow with harvestable mass
    float vein=smoothstep(0.92,1.0,vnoise(ang*6.0+r*9.0,s+11.0));
    col+=c.rgb*vein*0.9*c.a;
    float rim=smoothstep(0.05,0.0,abs(d+0.03))*lit;
    col+=vec3(0.5,0.6,0.7)*rim*0.25;
    o=vec4(col*fill,fill);
    return;
  }
  if(v_shape==5){ // tracer beam: bright head fading to tail
    float d=abs(p.y)/w;
    float t=v_uv.x*0.5+0.5;
    float a=smoothstep(1.0,0.0,d)*t*t;
    o=vec4(c.rgb*a*c.a*1.6, 0.0);
    return;
  }
  if(v_shape==6){ // hex shield bubble
    float r=length(v_uv);
    vec2 q=v_uv*7.0;
    q.x*=1.1547; q.y+=mod(floor(q.x),2.0)*0.5;
    vec2 f=abs(fract(q)-0.5);
    float hex=smoothstep(0.06,0.0,abs(max(f.x*1.5+f.y,f.y*2.0)-1.0))*0.6;
    float rim=smoothstep(0.85,1.0,r)*smoothstep(1.0,0.97,r);
    float a=(rim*1.2+hex*0.25*smoothstep(1.0,0.3,r)+0.05)*step(r,1.0);
    a*=0.8+0.2*sin(u_time*8.0+r*10.0);
    o=vec4(c.rgb*a*c.a, 0.0);
    return;
  }
  if(v_shape==7){ // bomb pool: swirling noisy hazard disk, alpha param
    float r=length(v_uv);
    float ang=atan(v_uv.y,v_uv.x);
    float sw=vnoise(ang*3.0+u_time*1.5-r*6.0, v_param.x);
    float a=smoothstep(1.0,0.6,r)*(0.35+0.4*sw);
    a+=smoothstep(0.05,0.0,abs(r-0.95))*0.6;
    o=vec4(c.rgb*a*c.a, 0.0);
    return;
  }
  o=vec4(c.rgb*c.a,0.0);
}`;

export const BRIGHT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_tex; uniform vec2 u_texel;
void main(){
  // 4-tap downsample with soft threshold.
  vec3 c=texture(u_tex,v_uv+u_texel*vec2(-0.5,-0.5)).rgb+texture(u_tex,v_uv+u_texel*vec2(0.5,-0.5)).rgb
        +texture(u_tex,v_uv+u_texel*vec2(-0.5,0.5)).rgb+texture(u_tex,v_uv+u_texel*vec2(0.5,0.5)).rgb;
  c*=0.25;
  float b=max(c.r,max(c.g,c.b));
  float k=smoothstep(0.18,0.7,b);
  o=vec4(c*k,1.0);
}`;

export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_tex; uniform vec2 u_dir;
void main(){
  vec3 c=texture(u_tex,v_uv).rgb*0.227027;
  c+=texture(u_tex,v_uv+u_dir*1.3846).rgb*0.3162162;
  c+=texture(u_tex,v_uv-u_dir*1.3846).rgb*0.3162162;
  c+=texture(u_tex,v_uv+u_dir*3.2308).rgb*0.0702703;
  c+=texture(u_tex,v_uv-u_dir*3.2308).rgb*0.0702703;
  o=vec4(c,1.0);
}`;

export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_scene; uniform sampler2D u_bloomA; uniform sampler2D u_bloomB;
uniform float u_aberr; uniform float u_flash; uniform vec3 u_flashColor;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
void main(){
  vec2 d=(v_uv-0.5);
  vec3 col;
  if(u_aberr>0.0005){
    col.r=texture(u_scene,v_uv+d*u_aberr).r;
    col.g=texture(u_scene,v_uv).g;
    col.b=texture(u_scene,v_uv-d*u_aberr).b;
  } else col=texture(u_scene,v_uv).rgb;
  vec3 bloom=texture(u_bloomA,v_uv).rgb*0.9+texture(u_bloomB,v_uv).rgb*1.1;
  col+=bloom;
  col+=u_flashColor*u_flash;
  col=aces(col*1.05);
  float vig=1.0-dot(d,d)*0.9;
  col*=vig;
  // Dither to kill banding in the dark gradients.
  float n=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);
  col+=(n-0.5)/255.0;
  o=vec4(col,1.0);
}`;
