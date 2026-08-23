const fs = require("node:fs");

const WASM_IMPORT_MODULE = "./qoder_auth_wasm_bg.js";
const WASM_SEARCH_WINDOW = 500_000;

function extractQoderAuthWasm(runtimePath) {
  const source = fs.readFileSync(runtimePath, "utf8");
  const markerIndex = source.indexOf("credential_storage_decrypt");
  if (markerIndex < 0) throw new Error("The installed Qoder CLI does not expose compatible authentication support.");
  const prefix = source.slice(Math.max(0, markerIndex - WASM_SEARCH_WINDOW), markerIndex);
  const matches = [...prefix.matchAll(/["']([A-Za-z0-9+/]{10000,}={0,2})["']/g)];
  const encoded = matches.at(-1)?.[1];
  if (!encoded) throw new Error("The installed Qoder CLI authentication module could not be located.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.subarray(0, 4).toString("hex") !== "0061736d") {
    throw new Error("The installed Qoder CLI authentication module is invalid.");
  }
  return bytes;
}

function createQoderAuthWasm(runtimePath) {
  let wasm;
  let memoryBytes;
  let memoryView;
  const heap = new Array(1024).fill(undefined);
  heap.push(undefined, null, true, false);
  let heapNext = heap.length;
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false });
  const encoder = new TextEncoder();

  function getObject(index) { return heap[index]; }
  function addObject(value) {
    if (heapNext === heap.length) heap.push(heap.length + 1);
    const index = heapNext;
    heapNext = heap[index];
    heap[index] = value;
    return index;
  }
  function dropObject(index) {
    if (index < 1028) return;
    heap[index] = heapNext;
    heapNext = index;
  }
  function takeObject(index) {
    const value = getObject(index);
    dropObject(index);
    return value;
  }
  function getBytes() {
    if (!memoryBytes || memoryBytes.byteLength === 0) memoryBytes = new Uint8Array(wasm.memory.buffer);
    return memoryBytes;
  }
  function getView() {
    if (!memoryView || memoryView.buffer !== wasm.memory.buffer) memoryView = new DataView(wasm.memory.buffer);
    return memoryView;
  }
  function getString(pointer, length) {
    const start = pointer >>> 0;
    return decoder.decode(getBytes().subarray(start, start + length));
  }
  function getByteSlice(pointer, length) {
    const start = pointer >>> 0;
    return getBytes().subarray(start, start + length);
  }
  function handleError(callback, args) {
    try {
      return callback(...args);
    } catch (error) {
      wasm.__wbindgen_export(addObject(error));
      return undefined;
    }
  }

  const imports = {
    [WASM_IMPORT_MODULE]: {
      __wbg_Error_2e59b1b37a9a34c3: (pointer, length) => addObject(Error(getString(pointer, length))),
      __wbg___wbindgen_is_function_49868bde5eb1e745: index => typeof getObject(index) === "function",
      __wbg___wbindgen_is_object_40c5a80572e8f9d3: index => typeof getObject(index) === "object" && getObject(index) !== null,
      __wbg___wbindgen_is_string_b29b5c5a8065ba1a: index => typeof getObject(index) === "string",
      __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: index => getObject(index) === undefined,
      __wbg___wbindgen_throw_81fc77679af83bc6: (pointer, length) => { throw new Error(getString(pointer, length)); },
      __wbg_call_d578befcc3145dee: (...args) => handleError((target, receiver, value) => addObject(
        getObject(target).call(getObject(receiver), getObject(value))
      ), args),
      __wbg_crypto_38df2bab126b63dc: index => addObject(getObject(index).crypto),
      __wbg_getRandomValues_c44a50d8cfdaebeb: (...args) => handleError((target, value) => {
        getObject(target).getRandomValues(getObject(value));
      }, args),
      __wbg_getRandomValues_d49329ff89a07af1: (...args) => handleError((pointer, length) => {
        globalThis.crypto.getRandomValues(getByteSlice(pointer, length));
      }, args),
      __wbg_length_0c32cb8543c8e4c8: index => getObject(index).length,
      __wbg_msCrypto_bd5a034af96bcba6: index => addObject(getObject(index).msCrypto),
      __wbg_new_99cabae501c0a8a0: () => addObject(new Map()),
      __wbg_new_with_length_9cedd08484b73942: length => addObject(new Uint8Array(length >>> 0)),
      __wbg_node_84ea875411254db1: index => addObject(getObject(index).node),
      __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
      __wbg_process_44c7a14e11e9f69e: index => addObject(getObject(index).process),
      __wbg_prototypesetcall_3e05eb9545565046: (pointer, length, value) => {
        Uint8Array.prototype.set.call(getByteSlice(pointer, length), getObject(value));
      },
      __wbg_randomFillSync_6c25eac9869eb53c: (...args) => handleError((target, value) => {
        getObject(target).randomFillSync(takeObject(value));
      }, args),
      __wbg_require_b4edbdcf3e2a1ef0: (...args) => handleError(() => addObject(require), args),
      __wbg_set_08463b1df38a7e29: (target, key, value) => addObject(getObject(target).set(getObject(key), getObject(value))),
      __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () => addObject(globalThis),
      __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => addObject(global),
      __wbg_static_accessor_SELF_24f78b6d23f286ea: () => 0,
      __wbg_static_accessor_WINDOW_59fd959c540fe405: () => 0,
      __wbg_subarray_0f98d3fb634508ad: (target, start, end) => addObject(getObject(target).subarray(start >>> 0, end >>> 0)),
      __wbg_versions_276b2795b1c6a219: index => addObject(getObject(index).versions),
      __wbindgen_cast_0000000000000001: (pointer, length) => addObject(getByteSlice(pointer, length)),
      __wbindgen_cast_0000000000000002: (pointer, length) => addObject(getString(pointer, length)),
      __wbindgen_object_clone_ref: index => addObject(getObject(index)),
      __wbindgen_object_drop_ref: index => takeObject(index)
    }
  };

  const module = new WebAssembly.Module(extractQoderAuthWasm(runtimePath));
  wasm = new WebAssembly.Instance(module, imports).exports;
  const requiredExports = [
    "credential_storage_decrypt",
    "qodercontext_new",
    "qodercontext_prepareRequest",
    "requestresult_headers",
    "requestresult_url"
  ];
  if (requiredExports.some(name => typeof wasm[name] !== "function")) {
    throw new Error("The installed Qoder CLI authentication module is incompatible.");
  }

  let vectorLength = 0;
  function passString(value) {
    const bytes = encoder.encode(value);
    const pointer = wasm.__wbindgen_export2(bytes.length, 1) >>> 0;
    getBytes().set(bytes, pointer);
    vectorLength = bytes.length;
    return pointer;
  }
  function passStrings(values) {
    return values.flatMap(value => {
      const pointer = passString(value);
      return [pointer, vectorLength];
    });
  }
  function readResult(retPointer, fieldCount = 3) {
    const view = getView();
    const value = view.getInt32(retPointer, true);
    const error = view.getInt32(retPointer + 4, true);
    const failed = fieldCount === 3 ? view.getInt32(retPointer + 8, true) : view.getInt32(retPointer + 12, true);
    if (failed) throw takeObject(fieldCount === 3 ? error : view.getInt32(retPointer + 8, true));
    return value >>> 0;
  }
  function decryptCredential(ciphertext, key) {
    const retPointer = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      wasm.credential_storage_decrypt(retPointer, ...passStrings([ciphertext, key]));
      const view = getView();
      const pointer = view.getInt32(retPointer, true);
      const length = view.getInt32(retPointer + 4, true);
      const failed = view.getInt32(retPointer + 12, true);
      if (failed) throw takeObject(view.getInt32(retPointer + 8, true));
      const value = getString(pointer, length);
      wasm.__wbindgen_export4(pointer, length, 1);
      return value;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  function generateRuntimeAuthFields(userInfo) {
    if (typeof wasm.generate_runtime_auth_fields !== "function") {
      throw new Error("The installed Qoder CLI cannot prepare compatible authentication fields.");
    }
    const retPointer = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      wasm.generate_runtime_auth_fields(retPointer, ...passStrings([JSON.stringify({
        uid: userInfo.uid,
        organization_id: userInfo.organization_id,
        organization_tags: userInfo.organization_tags,
        data_policy_agreed: userInfo.data_policy_agreed
      })]));
      const view = getView();
      const pointer = view.getInt32(retPointer, true);
      const length = view.getInt32(retPointer + 4, true);
      const failed = view.getInt32(retPointer + 12, true);
      if (failed) throw takeObject(view.getInt32(retPointer + 8, true));
      const value = JSON.parse(getString(pointer, length));
      wasm.__wbindgen_export4(pointer, length, 1);
      return value;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  function createContext(machineId, version, userInfo) {
    const retPointer = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      wasm.qodercontext_new(retPointer, ...passStrings([
        machineId,
        version,
        JSON.stringify(userInfo),
        JSON.stringify({
          client_type: "qoder",
          business_product: "qoder",
          business_type: "default",
          scene: "default"
        })
      ]));
      return readResult(retPointer);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  function readRequestResult(resultPointer) {
    const retPointer = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      wasm.requestresult_url(retPointer, resultPointer);
      const view = getView();
      const pointer = view.getInt32(retPointer, true);
      const length = view.getInt32(retPointer + 4, true);
      const url = getString(pointer, length);
      wasm.__wbindgen_export4(pointer, length, 1);
      const headers = takeObject(wasm.requestresult_headers(resultPointer));
      const bodyPointer = wasm.__wbindgen_add_to_stack_pointer(-16);
      let body;
      try {
        wasm.requestresult_body(bodyPointer, resultPointer);
        const bodyStart = getView().getInt32(bodyPointer, true);
        const bodyLength = getView().getInt32(bodyPointer + 4, true);
        if (bodyStart !== 0) {
          body = getString(bodyStart, bodyLength);
          wasm.__wbindgen_export4(bodyStart, bodyLength, 1);
        }
      } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
      }
      return { url, headers: Object.fromEntries(headers), ...(body === undefined ? {} : { body }) };
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
      wasm.__wbg_requestresult_free(resultPointer, 0);
    }
  }
  function prepareRequest(contextPointer, { endpoint, path, method = "GET", body, headers }) {
    const retPointer = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      const required = passStrings([endpoint, path, method, "auth"]);
      const optionalBody = body == null ? [0, 0] : passStrings([body]);
      const optionalHeaders = headers == null ? [0, 0] : passStrings([JSON.stringify(headers)]);
      wasm.qodercontext_prepareRequest(retPointer, contextPointer, ...required, ...optionalBody, ...optionalHeaders);
      return readRequestResult(readResult(retPointer));
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  function freeContext(contextPointer) {
    if (contextPointer) wasm.__wbg_qodercontext_free(contextPointer, 0);
  }
  function decryptServerResponse(value) {
    if (typeof wasm.decrypt_server_response !== "function") return value;
    const retPointer = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      wasm.decrypt_server_response(retPointer, ...passStrings([value]));
      const view = getView();
      const pointer = view.getInt32(retPointer, true);
      const length = view.getInt32(retPointer + 4, true);
      const failed = view.getInt32(retPointer + 12, true);
      if (failed) return value;
      const decrypted = getString(pointer, length);
      wasm.__wbindgen_export4(pointer, length, 1);
      return decrypted;
    } catch {
      return value;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }

  return { createContext, decryptCredential, decryptServerResponse, freeContext, generateRuntimeAuthFields, prepareRequest };
}

module.exports = { createQoderAuthWasm, extractQoderAuthWasm };
