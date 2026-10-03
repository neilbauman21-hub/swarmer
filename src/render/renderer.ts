import { BG_FS, BLUR_FS, BRIGHT_FS, COMPOSITE_FS, FULLSCREEN_VS, SPRITE_FS, SPRITE_VS } from './shaders';

export enum Shape {
  Glow = 0,
  Ring = 1,
  Disk = 2,
  Ship = 3,
  Rock = 4,
  Tracer = 5,
  Shield = 6,
  Pool = 7,
}

const STRIDE = 12;

/** Growable list of sprite instances. */
export class SpriteBatch {
  data: Float32Array;
  count = 0;
  constructor(capacity = 4096) {
    this.data = new Float32Array(capacity * STRIDE);
  }
  clear(): void {
    this.count = 0;
  }
  push(x: number, y: number, ax: number, ay: number, w: number, shape: number,
    r: number, g: number, b: number, a: number, p1 = 0, p2 = 0): void {
    if ((this.count + 1) * STRIDE > this.data.length) {
      const n = new Float32Array(this.data.length * 2);
      n.set(this.data);
      this.data = n;
    }
    const d = this.data, o = this.count * STRIDE;
    d[o] = x; d[o + 1] = y; d[o + 2] = ax; d[o + 3] = ay;
    d[o + 4] = w; d[o + 5] = shape;
    d[o + 6] = r; d[o + 7] = g; d[o + 8] = b; d[o + 9] = a;
    d[o + 10] = p1; d[o + 11] = p2;
    this.count++;
  }
}

export interface View {
  cx: number;
  cy: number;
  zoom: number; // device pixels per world unit
  time: number;
  size: number;
  aberration: number;
  flash: number;
  flashColor: [number, number, number];
}

interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private bg: WebGLProgram;
  private sprite: WebGLProgram;
  private bright: WebGLProgram;
  private blur: WebGLProgram;
  private comp: WebGLProgram;
  private quadVao: WebGLVertexArrayObject;
  private spriteVao: WebGLVertexArrayObject;
  private instBuf: WebGLBuffer;
  private instCap = 0;
  private hdr: boolean;
  private scene!: Target;
  private half!: Target;
  private q1!: Target;
  private q2!: Target;
  private e1!: Target;
  private e2!: Target;
  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  width = 1;
  height = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('OES_texture_float_linear');
    this.bg = this.program(FULLSCREEN_VS, BG_FS);
    this.sprite = this.program(SPRITE_VS, SPRITE_FS);
    this.bright = this.program(FULLSCREEN_VS, BRIGHT_FS);
    this.blur = this.program(FULLSCREEN_VS, BLUR_FS);
    this.comp = this.program(FULLSCREEN_VS, COMPOSITE_FS);

    // Fullscreen triangle-strip quad.
    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Sprite VAO: per-vertex corner + per-instance attributes.
    this.spriteVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    const B = STRIDE * 4;
    const attr = (loc: number, size: number, off: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, B, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(1, 4, 0);
    attr(2, 2, 4);
    attr(3, 4, 6);
    attr(4, 2, 10);
    gl.bindVertexArray(null);
    this.resize(1, 1);
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader error: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Link error: ${gl.getProgramInfoLog(p)}`);
    return p;
  }

  private u(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.uniforms.get(p);
    if (!m) { m = new Map(); this.uniforms.set(p, m); }
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name)!;
  }

  private target(w: number, h: number, old?: Target): Target {
    const gl = this.gl;
    if (old) { gl.deleteFramebuffer(old.fb); gl.deleteTexture(old.tex); }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && this.hdr) {
      // Fall back to 8-bit targets.
      this.hdr = false;
      gl.deleteFramebuffer(fb);
      gl.deleteTexture(tex);
      return this.target(w, h);
    }
    return { fb, tex, w, h };
  }

  resize(w: number, h: number): void {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    if (w === this.width && h === this.height && this.scene) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.scene = this.target(w, h, this.scene);
    this.half = this.target(w >> 1 || 1, h >> 1 || 1, this.half);
    this.q1 = this.target(w >> 2 || 1, h >> 2 || 1, this.q1);
    this.q2 = this.target(w >> 2 || 1, h >> 2 || 1, this.q2);
    this.e1 = this.target(w >> 3 || 1, h >> 3 || 1, this.e1);
    this.e2 = this.target(w >> 3 || 1, h >> 3 || 1, this.e2);
  }

  private bindTarget(t: Target | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    gl.viewport(0, 0, t ? t.w : this.width, t ? t.h : this.height);
  }

  private fullscreen(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private drawSprites(batch: SpriteBatch, view: View, additive: boolean): void {
    if (!batch.count) return;
    const gl = this.gl;
    gl.useProgram(this.sprite);
    gl.uniform2f(this.u(this.sprite, 'u_cam'), view.cx, view.cy);
    gl.uniform1f(this.u(this.sprite, 'u_zoom'), view.zoom);
    gl.uniform2f(this.u(this.sprite, 'u_res'), this.width, this.height);
    gl.uniform1f(this.u(this.sprite, 'u_time'), view.time);
    gl.bindVertexArray(this.spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    const bytes = batch.count * STRIDE * 4;
    if (bytes > this.instCap) {
      this.instCap = Math.max(bytes, this.instCap * 2);
      gl.bufferData(gl.ARRAY_BUFFER, this.instCap, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.data, 0, batch.count * STRIDE);
    gl.enable(gl.BLEND);
    if (additive) gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
    gl.disable(gl.BLEND);
  }

  render(view: View, under: SpriteBatch, solid: SpriteBatch, glow: SpriteBatch): void {
    const gl = this.gl;
    // 1. Backdrop.
    this.bindTarget(this.scene);
    gl.useProgram(this.bg);
    gl.uniform2f(this.u(this.bg, 'u_cam'), view.cx, view.cy);
    gl.uniform1f(this.u(this.bg, 'u_zoom'), view.zoom);
    gl.uniform2f(this.u(this.bg, 'u_res'), this.width, this.height);
    gl.uniform1f(this.u(this.bg, 'u_time'), view.time);
    gl.uniform1f(this.u(this.bg, 'u_size'), view.size);
    this.fullscreen();
    // 2. World.
    this.drawSprites(under, view, true);
    this.drawSprites(solid, view, false);
    this.drawSprites(glow, view, true);

    // 3. Bloom chain.
    this.bindTarget(this.half);
    gl.useProgram(this.bright);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.uniform1i(this.u(this.bright, 'u_tex'), 0);
    gl.uniform2f(this.u(this.bright, 'u_texel'), 1 / this.scene.w, 1 / this.scene.h);
    this.fullscreen();
    this.blurPass(this.half, this.q1, 1, 0);
    this.blurPass(this.q1, this.q2, 0, 1);
    this.blurPass(this.q2, this.e1, 1, 0);
    this.blurPass(this.e1, this.e2, 0, 1);
    this.blurPass(this.e2, this.e1, 1.5, 0);
    this.blurPass(this.e1, this.e2, 0, 1.5);

    // 4. Composite to screen.
    this.bindTarget(null);
    gl.useProgram(this.comp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.uniform1i(this.u(this.comp, 'u_scene'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.q2.tex);
    gl.uniform1i(this.u(this.comp, 'u_bloomA'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.e2.tex);
    gl.uniform1i(this.u(this.comp, 'u_bloomB'), 2);
    gl.uniform1f(this.u(this.comp, 'u_aberr'), view.aberration);
    gl.uniform1f(this.u(this.comp, 'u_flash'), view.flash);
    gl.uniform3f(this.u(this.comp, 'u_flashColor'), ...view.flashColor);
    this.fullscreen();
    gl.activeTexture(gl.TEXTURE0);
  }

  private blurPass(src: Target, dst: Target, dx: number, dy: number): void {
    const gl = this.gl;
    this.bindTarget(dst);
    gl.useProgram(this.blur);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(this.u(this.blur, 'u_tex'), 0);
    gl.uniform2f(this.u(this.blur, 'u_dir'), dx / src.w, dy / src.h);
    this.fullscreen();
  }
}
