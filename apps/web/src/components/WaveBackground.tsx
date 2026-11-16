import { onCleanup, onMount } from "solid-js";

// Waves and ordered dithering from Conduit's chat-art-draw.ts, without its image effects.
const vertex = `#version 300 es
in vec2 corner;
void main() { gl_Position = vec4(corner, 0.0, 1.0); }`;

const fragment = `#version 300 es
precision highp float;
uniform vec2 view, renderScale;
uniform vec3 waveTint;
uniform float time;
out vec4 colour;
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer8(vec2 a) { return bayer2(0.25 * a) * 0.0625 + bayer2(0.5 * a) * 0.25 + bayer2(a); }
void main() {
  vec2 pixel = gl_FragCoord.xy * renderScale;
  vec2 cell = floor(vec2(pixel.x, view.y - pixel.y) / 4.0);
  vec2 p = cell * 4.0 / view.y;
  vec2 q = p * 2.2 + 0.45 * vec2(sin(p.y * 2.6 + time * 0.2), cos(p.x * 2.1 - time * 0.16));
  float field = sin(q.x * 1.9 + time * 0.12) + sin(q.y * 2.7 - time * 0.1) + sin((q.x + q.y) * 1.3 + time * 0.07) + sin(length(q - vec2(1.6, 0.9)) * 3.1 - time * 0.17);
  float tone = min(3.0, floor(clamp(field * 0.125 + 0.5, 0.0, 1.0) * 3.0 + bayer8(cell)));
  colour = vec4(waveTint, tone / 3.0);
}`;

export function WaveBackground() {
  let canvas!: HTMLCanvasElement;

  onMount(() => {
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: false });
    if (!gl) return;
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    if (!program || !buffer) {
      if (program) gl.deleteProgram(program);
      if (buffer) gl.deleteBuffer(buffer);
      return;
    }
    const shaders: WebGLShader[] = [];
    onCleanup(() => {
      for (const shader of shaders) gl.deleteShader(shader);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    });
    const stages: [number, string][] = [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]];
    for (const [type, source] of stages) {
      const shader = gl.createShader(type);
      if (!shader) return;
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return;
      gl.attachShader(program, shader);
    }
    gl.bindAttribLocation(program, 0, "corner");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const view = gl.getUniformLocation(program, "view");
    const scale = gl.getUniformLocation(program, "renderScale");
    const time = gl.getUniformLocation(program, "time");
    const tint = gl.getUniformLocation(program, "waveTint");
    const colourScheme = matchMedia("(prefers-color-scheme: dark)");
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let lastDraw = -Infinity;

    const draw = (now: number) => {
      // Use CSS pixels so the dither stays 4px on high-density phone screens too.
      const wide = Math.max(1, Math.ceil(innerWidth / 4));
      const tall = Math.max(1, Math.ceil(innerHeight / 4));
      const width = wide * 4;
      const height = tall * 4;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      if (canvas.width !== wide || canvas.height !== tall) {
        canvas.width = wide;
        canvas.height = tall;
      }
      gl.viewport(0, 0, wide, tall);
      gl.uniform2f(view, width, height);
      gl.uniform2f(scale, width / wide, height / tall);
      const [red = 47, green = 111, blue = 143] = getComputedStyle(canvas).getPropertyValue("--sea-rgb").trim().split(/\s+/).map(Number);
      gl.uniform3f(tint, red / 255, green / 255, blue / 255);
      gl.uniform1f(time, reducedMotion.matches ? 0 : now / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const tick = (now: number) => {
      frame = 0;
      if (document.hidden || gl.isContextLost()) return;
      // The waves move slowly; 20 frames per second is enough for the backdrop.
      if (now - lastDraw >= 50) {
        draw(now);
        lastDraw = now;
      }
      if (!reducedMotion.matches) frame = requestAnimationFrame(tick);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      lastDraw = -Infinity;
      frame = requestAnimationFrame(tick);
    };
    const lost = (event: Event) => {
      event.preventDefault();
      cancelAnimationFrame(frame);
    };
    const themeObserver = new MutationObserver(restart);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    colourScheme.addEventListener("change", restart);
    addEventListener("resize", restart);
    document.addEventListener("visibilitychange", restart);
    reducedMotion.addEventListener("change", restart);
    canvas.addEventListener("webglcontextlost", lost);
    restart();
    onCleanup(() => {
      cancelAnimationFrame(frame);
      themeObserver.disconnect();
      colourScheme.removeEventListener("change", restart);
      removeEventListener("resize", restart);
      document.removeEventListener("visibilitychange", restart);
      reducedMotion.removeEventListener("change", restart);
      canvas.removeEventListener("webglcontextlost", lost);
    });
  });

  return <canvas class="wave-background" ref={canvas} aria-hidden="true" />;
}
