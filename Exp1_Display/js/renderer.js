'use strict';

// ---------------------------------------------------------------------------
// Renderer -- owns every WebGPU object and knows how to draw one frame.
//
// create() runs once and is expensive: it talks to the GPU process, requests an
// adapter and a device, and compiles the pipeline. render() runs whenever the
// picture changes and must stay cheap -- it only records commands.
//
// The `#name` fields are real private fields, invisible outside this class.
// ---------------------------------------------------------------------------

class Renderer {
  #canvas;
  #device;
  #context;
  #module;
  #format;
  #uniformByteLength;
  #pipeline;
  #vertexBuffer;
  #vertexCount;
  #uniformBuffer;
  #bindGroup;
  #staging;
  #adapterInfo;

  /**
   * Async factory. Everything that can fail or needs awaiting happens here,
   * so a fully built Renderer is always usable.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {{
   *   shaderCode: string,
   *   geometry: {vertices: Float32Array, vertexCount: number,
   *              layout: GPUVertexBufferLayout, topology: string},
   *   uniformByteLength?: number,
   * }} setup
   * @param {{onUncapturedError?: (text: string) => void}} [options]
   */
  static async create(canvas, setup, options = {}) {
    const { shaderCode, geometry, uniformByteLength = 0 } = setup;
    const { onUncapturedError } = options;

    if (!navigator.gpu) {
      throw new Error(
        'WebGPU is not available in this browser.\nUse Chrome or Edge.',
      );
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error(
        'WebGPU is present but requestAdapter() returned nothing.\n' +
          'The GPU may be blocklisted or disabled.',
      );
    }

    const device = await adapter.requestDevice();

    // WebGPU errors arrive asynchronously and are swallowed by default.
    // Without this listener a failure looks exactly like a blank screen.
    device.addEventListener('uncapturederror', (event) => {
      const text = '[webgpu] ' + event.error.message;
      if (onUncapturedError) {
        onUncapturedError(text);
      } else {
        console.error(text);
      }
    });

    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error(
        "canvas.getContext('webgpu') returned null.\n" +
          'The canvas may already hold a different context type.',
      );
    }

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format });

    const module = device.createShaderModule({
      code: shaderCode,
      label: 'hw1-shader',
    });

    // A uniform block exists independently of the geometry, so it is built
    // once here and shared by every shape that gets swapped in later.
    //
    // usage must include UNIFORM, and COPY_DST so writeBuffer may target it.
    // The size is supplied by the caller because it is dictated by the WGSL
    // struct, including its padding -- see scene.js.
    let uniformBuffer = null;
    if (uniformByteLength > 0) {
      uniformBuffer = device.createBuffer({
        label: 'hw1-uniforms',
        size: uniformByteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    const renderer = new Renderer({
      canvas,
      device,
      context,
      module,
      format,
      uniformBuffer,
      uniformByteLength,
      adapterInfo: adapter.info,
    });

    renderer.setGeometry(geometry);

    return renderer;
  }

  constructor({
    canvas,
    device,
    context,
    module,
    format,
    uniformBuffer,
    uniformByteLength,
    bindGroup,
    adapterInfo,
  }) {
    this.#canvas = canvas;
    this.#device = device;
    this.#context = context;
    this.#module = module;
    this.#format = format;
    this.#uniformBuffer = uniformBuffer;
    this.#uniformByteLength = uniformByteLength;
    this.#bindGroup = bindGroup;
    this.#adapterInfo = adapterInfo;

    // Scratch array reused by every upload. queue.writeBuffer copies the data
    // immediately, so reusing one array is safe and avoids per-frame garbage.
    this.#staging =
      uniformByteLength > 0
        ? new Float32Array(uniformByteLength / Float32Array.BYTES_PER_ELEMENT)
        : null;
  }

  /**
   * Replace the shape being drawn.
   *
   * Rebuilds the vertex buffer and the pipeline, because a pipeline bakes in
   * the layout and topology at creation. That is the cost of the immutable-
   * pipeline design, and why this is a deliberate call rather than a per-frame
   * one. Old resources are released by dropping the last reference.
   *
   * @param {{
   *   vertices: Float32Array,
   *   vertexCount: number,
   *   layout: GPUVertexBufferLayout,
   *   topology?: string,
   * }} geometry
   */
  setGeometry(geometry) {
    const device = this.#device;

    const vertexBuffer = device.createBuffer({
      label: 'hw1-vertices',
      // size is in BYTES; .byteLength already is. Using .length would silently
      // under-allocate.
      size: geometry.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // Queued, not awaited: queue ordering guarantees this lands before the
    // frame that reads the buffer executes.
    device.queue.writeBuffer(vertexBuffer, 0, geometry.vertices);

    const pipeline = device.createRenderPipeline({
      label: 'hw1-pipeline',
      layout: 'auto',
      vertex: {
        module: this.#module,
        entryPoint: 'vs',
        buffers: [geometry.layout],
      },
      fragment: {
        module: this.#module,
        entryPoint: 'fs',
        targets: [
          {
            format: this.#format,
            // Alpha blending, needed for the fractal coverage. The shader
            // writes the surviving fraction as alpha, so a pixel fully inside a
            // hole contributes nothing. Without blending, alpha would be
            // ignored and the holes would paint opaque.
            //
            // The alpha channel uses 'one' rather than 'src-alpha':
            // multiplying alpha by itself would make partly covered pixels
            // partly transparent against the page behind the canvas.
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: {
        topology: geometry.topology || 'triangle-list',
      },
    });

    // layout:'auto' has WebGPU derive the bind group layout from the WGSL, so
    // it is fetched back rather than described by hand. Binding 0 matches
    // @binding(0) and the group index matches @group(0).
    let bindGroup = null;
    if (this.#uniformBuffer) {
      bindGroup = device.createBindGroup({
        label: 'hw1-bind-group',
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: {
              buffer: this.#uniformBuffer,
              offset: 0,
              size: this.#uniformByteLength,
            },
          },
        ],
      });
    }

    this.#vertexBuffer = vertexBuffer;
    this.#vertexCount = geometry.vertexCount;
    this.#pipeline = pipeline;
    this.#bindGroup = bindGroup;
  }

  /**
   * Queue new per-draw parameters. Uploads but does not draw; queue ordering
   * guarantees the following frame sees them.
   *
   * @param {SceneParams} params
   */
  setParams(params) {
    if (!this.#uniformBuffer) {
      return;
    }

    params.writeInto(this.#staging);
    this.#device.queue.writeBuffer(this.#uniformBuffer, 0, this.#staging);
  }

  get adapterInfo() {
    return this.#adapterInfo;
  }

  /** @returns {number} how many vertices the current shape draws */
  get vertexCount() {
    return this.#vertexCount;
  }

  /**
   * Match the drawing resolution to the displayed size.
   *
   * clientWidth is the DISPLAYED size in CSS pixels; canvas.width is the
   * RESOLUTION in device pixels. They are independent, and the drawing buffer
   * defaults to 300x150.
   *
   * @returns {boolean} true if the resolution actually changed
   */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(this.#canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.#canvas.clientHeight * dpr));

    if (width === this.#canvas.width && height === this.#canvas.height) {
      return false;
    }

    this.#canvas.width = width;
    this.#canvas.height = height;
    return true;
  }

  /**
   * The displayed size in CSS pixels. Read rather than assumed: on a cold load
   * the stylesheet may not have applied yet and clientWidth reads as 1.
   *
   * @returns {{width: number, height: number}}
   */
  measure() {
    return {
      width: this.#canvas.clientWidth,
      height: this.#canvas.clientHeight,
    };
  }

  get resolution() {
    return { width: this.#canvas.width, height: this.#canvas.height };
  }

  /**
   * Record one frame and hand it to the GPU. Nothing draws until submit();
   * the calls above it only append to a command buffer.
   */
  render() {
    // The canvas texture is recycled between frames, so the current view must
    // be fetched fresh every time.
    const view = this.#context.getCurrentTexture().createView();

    const encoder = this.#device.createCommandEncoder({ label: 'hw1-encoder' });

    const pass = encoder.beginRenderPass({
      label: 'hw1-pass',
      colorAttachments: [
        {
          view,
          clearValue: [0.12, 0.12, 0.14, 1.0],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    pass.setPipeline(this.#pipeline);

    // Slot 0 refers to vertex.buffers[0] in the pipeline. Like setPipeline,
    // this only records an entry.
    pass.setVertexBuffer(0, this.#vertexBuffer);

    // Group 0 matches @group(0) in the shader.
    if (this.#bindGroup) {
      pass.setBindGroup(0, this.#bindGroup);
    }

    // The count is VERTICES, not triangles, and comes from the data so the two
    // cannot disagree.
    pass.draw(this.#vertexCount);
    pass.end();

    this.#device.queue.submit([encoder.finish()]);
  }
}
