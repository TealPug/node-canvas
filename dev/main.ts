import { NodeCanvas } from "../src/core/NodeCanvas.js";
import { comfyuiToGraphData, graphDataToComfyUI } from "../src/converters/comfyui.js";
import type { ComfyUIRawWorkflow } from "../src/converters/comfyui.js";
import type { GraphData } from "../src/types/index.js";

// -- DOM elements --

const editorEl = document.getElementById("editor")!;
const filenameEl = document.getElementById("filename")!;
const nodeCountEl = document.getElementById("nodeCount")!;
const btnOpen = document.getElementById("btnOpen") as HTMLButtonElement;
const btnSave = document.getElementById("btnSave") as HTMLButtonElement;
const btnSaveAs = document.getElementById("btnSaveAs") as HTMLButtonElement;
const btnFit = document.getElementById("btnFit") as HTMLButtonElement;
const btnLayout = document.getElementById("btnLayout") as HTMLButtonElement;
const toastEl = document.getElementById("toast")!;

// -- State --

let editor: NodeCanvas | null = null;
let currentFileHandle: FileSystemFileHandle | null = null;
let currentFileName = "";

// -- Toast --

let toastTimer: ReturnType<typeof setTimeout>;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 2500);
}

// -- Editor setup --

function initEditor(data: GraphData, filename: string) {
  if (editor) editor.destroy();

  editor = new NodeCanvas(editorEl, { data });

  currentFileName = filename;
  filenameEl.textContent = filename;
  updateNodeCount(data);

  editor.on("graph:change", ({ data }) => updateNodeCount(data));

  btnSave.disabled = false;
  btnSaveAs.disabled = false;
  btnFit.disabled = false;
  btnLayout.disabled = false;

  // Fit to view after a frame so the container has dimensions
  requestAnimationFrame(() => editor!.zoomToFit());

  toast(`Loaded ${filename}`);
}

function updateNodeCount(data: GraphData) {
  nodeCountEl.textContent = `${data.nodes.length} nodes · ${data.connections.length} connections`;
}

// -- File operations --

async function openFile() {
  // Try File System Access API first, fall back to file input
  if ("showOpenFilePicker" in window) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [
          {
            description: "ComfyUI Workflow",
            accept: { "application/json": [".json"] },
          },
        ],
      });
      currentFileHandle = handle;
      const file = await handle.getFile();
      const text = await file.text();
      const raw = JSON.parse(text) as ComfyUIRawWorkflow;
      const data = comfyuiToGraphData(raw);
      initEditor(data, file.name);
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      toast("Failed to open file");
      console.error(e);
    }
  } else {
    // Fallback for Firefox/others
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const raw = JSON.parse(text) as ComfyUIRawWorkflow;
      const data = comfyuiToGraphData(raw);
      currentFileHandle = null;
      initEditor(data, file.name);
    };
    input.click();
  }
}

function getExportJSON(): string {
  if (!editor) return "";
  const graphData = editor.getGraphData();
  const comfyui = graphDataToComfyUI(graphData);
  return JSON.stringify(comfyui, null, 2);
}

async function saveFile() {
  if (!editor) return;

  const json = getExportJSON();

  if (currentFileHandle) {
    try {
      const writable = await currentFileHandle.createWritable();
      await writable.write(json);
      await writable.close();
      toast(`Saved ${currentFileName}`);
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      toast("Failed to save");
      console.error(e);
    }
  } else {
    await saveFileAs();
  }
}

async function saveFileAs() {
  if (!editor) return;

  const json = getExportJSON();

  if ("showSaveFilePicker" in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: currentFileName || "workflow.json",
        types: [
          {
            description: "ComfyUI Workflow",
            accept: { "application/json": [".json"] },
          },
        ],
      });
      currentFileHandle = handle;
      currentFileName = handle.name;
      filenameEl.textContent = handle.name;
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      toast(`Saved ${handle.name}`);
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      toast("Failed to save");
      console.error(e);
    }
  } else {
    // Fallback: download
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentFileName || "workflow.json";
    a.click();
    URL.revokeObjectURL(url);
    toast(`Downloaded ${a.download}`);
  }
}

// -- Button bindings --

btnOpen.addEventListener("click", openFile);
btnSave.addEventListener("click", saveFile);
btnSaveAs.addEventListener("click", saveFileAs);
btnFit.addEventListener("click", () => editor?.zoomToFit());
btnLayout.addEventListener("click", async () => {
  if (!editor) return;
  toast("Computing layout…");
  await editor.autoLayout();
  editor.zoomToFit();
  toast("Layout applied");
});

// -- Keyboard shortcuts --

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey) {
    if (e.key === "o") {
      e.preventDefault();
      openFile();
    } else if (e.key === "s") {
      e.preventDefault();
      if (e.shiftKey) {
        saveFileAs();
      } else {
        saveFile();
      }
    }
  }
});
