/* global BigInt */
import { saveAs } from "file-saver";
import JSZip from "jszip";
import pako from "pako";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    FaDownload,
    FaWrench,
    FaUpload,
    FaChevronLeft,
    FaChevronRight,
    FaTrash,
} from "react-icons/fa";
import "../../css/BlockToolsSidebar.css";
import { cameraManager } from "../Camera";
import { environmentModels } from "../EnvironmentBuilder";
import {
    batchProcessCustomBlocks,
    blockTypes,
    getCustomBlocks,
    processCustomBlock,
    getBlockById,
} from "../managers/BlockTypesManager";
import { DatabaseManager, STORES } from "../managers/DatabaseManager";
import { generateSchematicPreview } from "../utils/SchematicPreviewRenderer";
import BlockButton from "./BlockButton";
import EnvironmentButton from "./EnvironmentButton";
import { BlockIcon } from "./icons/BlockIcon";
import { PalmTreeIcon } from "./icons/PalmTreeIcon";
import { BlocksIcon } from "./icons/BlocksIcon";
import {
    suggestMapping,
    DEFAULT_BLOCK_MAPPINGS,
} from "../utils/minecraft/BlockMapper";
import { NBTParser } from "../utils/minecraft/NBTParser";
import { AxiomBlockRemapper } from "./AxiomBlockRemapper";

let selectedBlockID = 0;
const DEBUG_BP_IMPORT = true;
export const refreshBlockTools = () => {
    const event = new CustomEvent("refreshBlockTools");
    window.dispatchEvent(event);
};

if (typeof window !== "undefined") {
    window.refreshBlockTools = refreshBlockTools;
}

const dataURLtoBlob = (dataurl) => {
    if (!dataurl || !dataurl.startsWith("data:image")) return null;
    try {
        const arr = dataurl.split(",");
        const mimeMatch = arr[0].match(/:(.*?);/);
        if (!mimeMatch) return null;
        const mime = mimeMatch[1];
        const bstr = atob(arr[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
        }
        return new Blob([u8arr], { type: mime });
    } catch (e) {
        console.error("Error converting data URL to Blob:", e);
        return null;
    }
};

const createPlaceholderBlob = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 16; // Or your default texture size
    canvas.height = 16;
    const ctx = canvas.getContext("2d");
    if (ctx) {
        ctx.fillStyle = "#FF00FF"; // Magenta
        ctx.fillRect(0, 0, 16, 16);

        return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    }
    return Promise.resolve(null); // Fallback
};
const firstDefaultModel = environmentModels.find((m) => !m.isCustom);
const initialPreviewUrl = firstDefaultModel?.modelUrl ?? null;

const BlockToolsSidebar = ({
    activeTab,
    terrainBuilderRef,
    setActiveTab,
    setCurrentBlockType,
    environmentBuilder,
    onPlacementSettingsChange,
    setPlacementSize,
    onOpenTextureModal,
    onLoadSchematicFromHistory,
    isCompactMode,
}) => {
    const [customBlocks, setCustomBlocks] = useState([]);
    const [searchQuery, setSearchQuery] = useState("");
    const [selectedModelCategory, setSelectedModelCategory] = useState("All");
    const [categoryScrollIndex, setCategoryScrollIndex] = useState(0);
    const [hasNavigatedCategories, setHasNavigatedCategories] = useState(false);
    const [netNavigationCount, setNetNavigationCount] = useState(0);
    /** @type {[import("./AIAssistantPanel").SchematicHistoryEntry[], Function]} */
    const [schematicList, setSchematicList] = useState([]);
    const [schematicPreviews, setSchematicPreviews] = useState({});
    const schematicPreviewsRef = useRef(schematicPreviews);
    const [selectedComponentID, setSelectedComponentID] = useState(null);

    // Block remapper state
    const [showBlockRemapper, setShowBlockRemapper] = useState(false);
    const [pendingBpImport, setPendingBpImport] = useState(null);
    const [unmappedBlocks, setUnmappedBlocks] = useState([]);
    const [blockCounts, setBlockCounts] = useState({});
    const schematicListStateRef = useRef(schematicList);
    const isGeneratingPreviews = useRef(false);
    const currentPreviewIndex = useRef(0);
    const fileInputRef = useRef(null);
    const bpFileInputRef = useRef(null);

    useEffect(() => {
        const savedBlockId = localStorage.getItem("selectedBlock");
        if (savedBlockId) {
            selectedBlockID = parseInt(savedBlockId);
        }
        try {
            const savedComp = localStorage.getItem("selectedComponentId");
            if (savedComp) setSelectedComponentID(savedComp);
        } catch (_) {}
    }, []);

    const loadSchematicsFromDB = useCallback(async () => {
        console.log("[BlockToolsSidebar] Loading schematics from DB...");
        try {
            const { DatabaseManager, STORES } = await import(
                "../managers/DatabaseManager"
            );
            const db = await DatabaseManager.getDBConnection();
            const tx = db.transaction(STORES.SCHEMATICS, "readonly");
            const store = tx.objectStore(STORES.SCHEMATICS);
            const cursorRequest = store.openCursor();
            /** @type {import("./AIAssistantPanel").SchematicHistoryEntry[]} */
            const loadedSchematics = [];

            cursorRequest.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const dbKey = cursor.key;
                    const dbValue = cursor.value;
                    // Basic check for V2 schematic structure
                    if (
                        dbValue &&
                        typeof dbValue.prompt === "string" &&
                        dbValue.schematic &&
                        typeof dbValue.timestamp === "number"
                    ) {
                        loadedSchematics.push({
                            id: dbKey,
                            prompt: dbValue.prompt,
                            name: dbValue.name || "",
                            schematic: dbValue.schematic,
                            timestamp: dbValue.timestamp,
                        });
                    }
                    cursor.continue();
                } else {
                    loadedSchematics.sort((a, b) => b.timestamp - a.timestamp);

                    const currentSchematicListFromState =
                        schematicListStateRef.current;
                    let listsAreIdentical =
                        currentSchematicListFromState.length ===
                        loadedSchematics.length;

                    if (listsAreIdentical && loadedSchematics.length > 0) {
                        for (let i = 0; i < loadedSchematics.length; i++) {
                            if (
                                currentSchematicListFromState[i].id !==
                                    loadedSchematics[i].id ||
                                currentSchematicListFromState[i].timestamp !==
                                    loadedSchematics[i].timestamp
                            ) {
                                listsAreIdentical = false;
                                break;
                            }
                        }
                    }

                    if (!listsAreIdentical) {
                        console.log(
                            `[BlockToolsSidebar] Schematic list changed or initial load. Updating state with ${loadedSchematics.length} schematics.`
                        );
                        setSchematicList(loadedSchematics);
                    } else {
                        console.log(
                            `[BlockToolsSidebar] Loaded ${loadedSchematics.length} schematics from DB, list content (IDs, timestamps) is unchanged. Skipping state update.`
                        );
                    }
                }
            };
            cursorRequest.onerror = (event) => {
                console.error(
                    "[BlockToolsSidebar] Error reading schematics store:",
                    event.target.error
                );
            };
        } catch (err) {
            console.error(
                "[BlockToolsSidebar] Error accessing DB for schematics:",
                err
            );
        }
    }, []);

    useEffect(() => {
        if (activeTab === "components") {
            loadSchematicsFromDB();
        }
        const handleSchematicsUpdated = () => {
            console.log(
                "[BlockToolsSidebar] schematicsDbUpdated event received."
            );
            if (
                document.visibilityState === "visible" &&
                activeTab === "components"
            ) {
                loadSchematicsFromDB();
            }
        };
        window.addEventListener("schematicsDbUpdated", handleSchematicsUpdated);

        return () => {
            window.removeEventListener(
                "schematicsDbUpdated",
                handleSchematicsUpdated
            );
        };
    }, [activeTab, loadSchematicsFromDB]);

    useEffect(() => {
        if (!selectedComponentID) return;
        const exists = schematicList.some((s) => s.id === selectedComponentID);
        if (!exists) {
            setSelectedComponentID(null);
            try {
                localStorage.removeItem("selectedComponentId");
            } catch (_) {}
        }
    }, [schematicList, selectedComponentID]);

    useEffect(() => {
        if (activeTab === "environment" && initialPreviewUrl) {
            const model = environmentModels.find(
                (m) => m.modelUrl === initialPreviewUrl
            );
            if (model) {
                selectedBlockID = model.id;
                setCurrentBlockType({
                    ...model,
                    isEnvironment: true,
                });
                console.log(
                    "Initial environment model auto-selected:",
                    model.name
                );
            }
        }
    }, []);

    useEffect(() => {
        const handleRefresh = () => {
            console.log("Handling refresh event in BlockToolsSidebar");
            try {
                const customBlocksData = getCustomBlocks();
                console.log("Custom blocks loaded:", customBlocksData);
                setCustomBlocks(customBlocksData);
                // Also sync currently selected block from localStorage so the
                // visual selection updates when programmatic selection occurs
                try {
                    const saved = localStorage.getItem("selectedBlock");
                    if (saved) {
                        const parsed = parseInt(saved);
                        if (!isNaN(parsed)) {
                            selectedBlockID = parsed;
                        }
                    }
                } catch (_) {}
            } catch (error) {
                console.error("Error refreshing custom blocks:", error);
            }
        };

        const handleCustomBlocksUpdated = (event) => {
            console.log(
                "Custom blocks updated from Minecraft importer:",
                event.detail?.blocks
            );
            handleRefresh();
        };

        handleRefresh();

        window.addEventListener("refreshBlockTools", handleRefresh);
        window.addEventListener("custom-blocks-loaded", handleRefresh);
        window.addEventListener(
            "custom-blocks-updated",
            handleCustomBlocksUpdated
        );
        window.addEventListener("textureAtlasUpdated", handleRefresh);
        return () => {
            window.removeEventListener("refreshBlockTools", handleRefresh);
            window.removeEventListener("custom-blocks-loaded", handleRefresh);
            window.removeEventListener(
                "custom-blocks-updated",
                handleCustomBlocksUpdated
            );
            window.removeEventListener("textureAtlasUpdated", handleRefresh);
        };
    }, []);

    useEffect(() => {
        schematicPreviewsRef.current = schematicPreviews;
    }, [schematicPreviews]);

    useEffect(() => {
        schematicListStateRef.current = schematicList;
    }, [schematicList]);

    // Listen for explicit remap requests from the ComponentOptions UI
    useEffect(() => {
        const handler = (e) => {
            try {
                const comp = e?.detail?.component;
                if (!comp || !comp.schematic) return;
                const schematic = comp.schematic;
                const blocksMeta = comp.blocksMeta || {};
                // Build names from blocksMeta
                const sourceIdToName = {};
                Object.keys(blocksMeta || {}).forEach((k) => {
                    const info = blocksMeta[k];
                    const nm = (info && (info.name || info.id || k)) + "";
                    sourceIdToName[k] = nm;
                });
                // If blocksMeta is empty, derive names from current registry
                if (Object.keys(sourceIdToName).length === 0) {
                    try {
                        const reg = window.BlockTypeRegistry?.instance;
                        const blocksObjProbe =
                            (schematic && schematic.blocks) || schematic || {};
                        for (const pos in blocksObjProbe) {
                            const sidStr = String(blocksObjProbe[pos]);
                            if (sourceIdToName[sidStr]) continue;
                            const bt = reg?.getBlockType?.(
                                parseInt(sidStr, 10)
                            );
                            if (bt?.name) sourceIdToName[sidStr] = bt.name;
                        }
                    } catch (_) {}
                }
                const blocksObj =
                    (schematic && schematic.blocks) || schematic || {};
                const countsByName = {};
                for (const pos in blocksObj) {
                    const sid = blocksObj[pos];
                    const nm = sourceIdToName[String(sid)] || `Block_${sid}`;
                    countsByName[nm] = (countsByName[nm] || 0) + 1;
                }
                const names = Object.keys(countsByName);
                // Show remapper
                setPendingComponentImport({
                    file: null,
                    name: comp.name || "Remapped Component",
                    prompt:
                        comp.prompt ||
                        `Remapped Component: ${comp.name || comp.id}`,
                    schematic,
                    sourceIdToName,
                    countsByName,
                });
                setUnmappedBlocks(names);
                setBlockCounts(countsByName);
                setShowBlockRemapper(true);
            } catch (err) {
                console.warn("Failed to start component remap: ", err);
            }
        };
        window.addEventListener("requestComponentRemap", handler);
        return () => {
            window.removeEventListener("requestComponentRemap", handler);
        };
    }, []);

    useEffect(() => {
        const processQueue = async () => {
            if (
                currentPreviewIndex.current >= schematicList.length ||
                !isGeneratingPreviews.current
            ) {
                isGeneratingPreviews.current = false;
                console.log(
                    "[BlockToolsSidebar] Finished preview generation queue or queue stopped."
                );
                if (currentPreviewIndex.current > 0) {
                    requestAnimationFrame(() => {
                        if (cameraManager) {
                            cameraManager.loadSavedState();
                            console.log(
                                "[BlockToolsSidebar] Camera state restored after preview generation batch."
                            );
                        }
                    });
                }
                currentPreviewIndex.current = 0;
                return;
            }

            const entry = schematicList[currentPreviewIndex.current];

            if (!entry.schematic) {
                console.log(
                    `[BlockToolsSidebar] No schematic data for entry ${entry.id} (index ${currentPreviewIndex.current}), marking as null.`
                );
                setSchematicPreviews((prevPreviews) => ({
                    ...prevPreviews,
                    [entry.id]: null,
                }));
            } else if (
                schematicPreviewsRef.current[entry.id] === undefined ||
                schematicPreviewsRef.current[entry.id] === null
            ) {
                // Check if preview already exists in IndexedDB and use it if available
                let previewFromDB = null;
                try {
                    previewFromDB = await DatabaseManager.getData(
                        STORES.PREVIEWS,
                        entry.id
                    );
                } catch (dbErr) {
                    // ignore, will generate preview below
                }

                if (previewFromDB && typeof previewFromDB === "string") {
                    setSchematicPreviews((prev) => ({
                        ...prev,
                        [entry.id]: previewFromDB,
                    }));
                    schematicPreviewsRef.current[entry.id] = previewFromDB;
                    // Skip generation as we already have it
                } else {
                    let newPreviewDataUrl = null;
                    let errorOccurred = false;
                    try {
                        console.log(
                            `[BlockToolsSidebar] Generating preview for schematic (index ${
                                currentPreviewIndex.current
                            }): ${entry.prompt.substring(0, 30)}...`
                        );
                        const blocksForPreview =
                            entry.schematic && entry.schematic.blocks
                                ? entry.schematic.blocks
                                : entry.schematic;
                        newPreviewDataUrl = await generateSchematicPreview(
                            blocksForPreview,
                            {
                                width: 48,
                                height: 48,
                                background: "transparent",
                            }
                        );
                    } catch (error) {
                        console.error(
                            `[BlockToolsSidebar] Error generating preview for schematic ${entry.id}:`,
                            error
                        );
                        errorOccurred = true;
                    }

                    // If preview was generated (and not errored), cache it in DB for future sessions
                    if (!errorOccurred && newPreviewDataUrl) {
                        try {
                            await DatabaseManager.saveData(
                                STORES.PREVIEWS,
                                entry.id,
                                newPreviewDataUrl
                            );
                        } catch (saveErr) {
                            console.warn(
                                "Failed to cache schematic preview:",
                                saveErr
                            );
                        }
                    }

                    setSchematicPreviews((prevPreviews) => ({
                        ...prevPreviews,
                        [entry.id]: errorOccurred
                            ? null
                            : newPreviewDataUrl || null,
                    }));
                }
            }

            currentPreviewIndex.current++;
            requestAnimationFrame(processQueue);
        };

        if (schematicList.length > 0) {
            if (!isGeneratingPreviews.current) {
                let needsProcessing = false;
                for (const entry of schematicList) {
                    // If preview is undefined (never processed) or null (failed/no data), it needs processing.
                    if (
                        schematicPreviewsRef.current[entry.id] === undefined ||
                        schematicPreviewsRef.current[entry.id] === null
                    ) {
                        needsProcessing = true;
                        break;
                    }
                }

                if (needsProcessing) {
                    console.log(
                        "[BlockToolsSidebar] Starting/Restarting preview generation queue as items need processing."
                    );
                    isGeneratingPreviews.current = true;
                    currentPreviewIndex.current = 0;
                    requestAnimationFrame(processQueue);
                } else {
                    console.log(
                        "[BlockToolsSidebar] All schematics processed or no new items/failures."
                    );
                }
            } else {
                // console.log("[BlockToolsSidebar] Preview generation already in progress."); // Can be noisy
            }
        } else if (schematicList.length === 0) {
            setSchematicPreviews({});
            isGeneratingPreviews.current = false;
            currentPreviewIndex.current = 0;
        }

        return () => {
            isGeneratingPreviews.current = false;
            console.log(
                "[BlockToolsSidebar] Preview generation queue stopped due to cleanup or schematicList change."
            );
        };
    }, [schematicList]);

    // Load previews from DB when schematic list changes
    useEffect(() => {
        const fetchPreviews = async () => {
            if (schematicList.length === 0) return;
            const updates = {};
            for (const entry of schematicList) {
                if (schematicPreviewsRef.current[entry.id] !== undefined)
                    continue;
                try {
                    const preview = await DatabaseManager.getData(
                        STORES.PREVIEWS,
                        entry.id
                    );
                    if (preview) {
                        updates[entry.id] = preview;
                    }
                } catch {
                    // ignore
                }
            }
            if (Object.keys(updates).length > 0) {
                setSchematicPreviews((prev) => ({ ...prev, ...updates }));
            }
        };
        fetchPreviews();
    }, [schematicList]);

    const handleDragStart = (blockId) => {
        console.log("Drag started with block:", blockId);
    };

    const handleDownloadAllCustom = async () => {
        const zip = new JSZip();
        const root = zip.folder("custom");
        const faceKeys = ["+x", "-x", "+y", "-y", "+z", "-z"];
        const list = getCustomBlocks();
        for (const block of list) {
            const folder = root.folder(block.name);
            const textures = block.sideTextures || {};
            const mainTex = block.textureUri;
            for (const key of faceKeys) {
                const dataUrl = textures[key] || mainTex;
                let blob = dataURLtoBlob(dataUrl);
                if (!blob) blob = await createPlaceholderBlob();
                folder.file(`${key}.png`, blob || new Blob());
            }
        }
        try {
            const zipBlob = await zip.generateAsync({ type: "blob" });
            saveAs(zipBlob, "custom.zip");
            console.log("Downloaded custom.zip");
        } catch (err) {
            console.error("Error saving custom.zip: ", err);
            alert("Failed to save custom.zip. See console.");
        }
    };

    const sanitizeFileName = (name) => {
        if (!name) return "component";
        return name
            .toString()
            .trim()
            .replace(/\s+/g, "-")
            .replace(/[^a-zA-Z0-9-_\.]/g, "-")
            .replace(/-+/g, "-")
            .substring(0, 64);
    };

    const buildBlocksMetaForSchematic = (schematic) => {
        try {
            const blocksObj =
                (schematic && schematic.blocks) || schematic || {};
            const usedIds = new Set();
            for (const key in blocksObj) {
                const id = blocksObj[key];
                if (typeof id === "number") usedIds.add(id);
            }
            const meta = {};
            usedIds.forEach((id) => {
                const bt = getBlockById?.(id);
                if (bt) {
                    meta[id] = {
                        id: bt.id,
                        name: bt.name,
                        isCustom: !!bt.isCustom,
                        isMultiTexture: !!bt.isMultiTexture,
                        textureUri: bt.textureUri || null,
                        sideTextures: bt.sideTextures || null,
                        lightLevel:
                            typeof bt.lightLevel === "number"
                                ? bt.lightLevel
                                : undefined,
                    };
                }
            });
            return meta;
        } catch (e) {
            console.warn("Failed to build blocksMeta for schematic:", e);
            return {};
        }
    };

    const handleDownloadAllComponents = async () => {
        try {
            const zip = new JSZip();
            const folder = zip.folder("components");

            // Read all schematics directly from DB to ensure latest
            const db = await DatabaseManager.getDBConnection();
            const tx = db.transaction(STORES.SCHEMATICS, "readonly");
            const store = tx.objectStore(STORES.SCHEMATICS);
            const cursorRequest = store.openCursor();

            const addFilePromises = [];
            cursorRequest.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const entry = cursor.value;
                    const name = sanitizeFileName(
                        entry?.name || entry?.prompt || cursor.key
                    );
                    const fileName = `${name || "component"}-${
                        cursor.key
                    }.json`;
                    const exportEntry = {
                        ...entry,
                        blocksMeta: buildBlocksMetaForSchematic(
                            entry?.schematic
                        ),
                    };
                    const json = JSON.stringify(exportEntry, null, 2);
                    addFilePromises.push(
                        Promise.resolve().then(() =>
                            folder.file(fileName, json)
                        )
                    );
                    cursor.continue();
                } else {
                    Promise.all(addFilePromises)
                        .then(() => zip.generateAsync({ type: "blob" }))
                        .then((blob) => saveAs(blob, "components.zip"))
                        .catch((err) => {
                            console.error(
                                "Failed to build components.zip",
                                err
                            );
                            alert(
                                "Failed to build components.zip. See console."
                            );
                        });
                }
            };
            cursorRequest.onerror = (event) => {
                console.error(
                    "Error iterating schematics store:",
                    event.target.error
                );
                alert("Failed to read components from DB. See console.");
            };
        } catch (err) {
            console.error("Error downloading all components:", err);
            alert("Failed to download components. See console.");
        }
    };

    const handleDeleteAllComponents = async () => {
        const confirmed = window.confirm(
            "Delete ALL saved components? This cannot be undone."
        );
        if (!confirmed) return;

        try {
            // Attempt to clear previews for known entries to avoid orphaned previews
            if (schematicList && schematicList.length > 0) {
                await Promise.all(
                    schematicList.map((e) =>
                        DatabaseManager.deleteData(STORES.PREVIEWS, e.id).catch(
                            () => {}
                        )
                    )
                );
            }

            await DatabaseManager.clearStore(STORES.SCHEMATICS);

            // Reset local UI/state
            setSchematicList([]);
            setSchematicPreviews({});
            setCurrentBlockType(null);
            selectedBlockID = 0;
            setSelectedComponentID(null);
            try {
                localStorage.removeItem("selectedComponentId");
            } catch (_) {}
            try {
                terrainBuilderRef?.current?.activateTool?.(null);
            } catch (_) {}

            window.dispatchEvent(new Event("schematicsDbUpdated"));
        } catch (err) {
            console.error("Failed to delete all components:", err);
            alert("Failed to delete all components. See console for details.");
        }
    };

    const handleTabChange = (newTab) => {
        // Always deactivate any active tool (including Terrain) when switching tabs
        try {
            terrainBuilderRef?.current?.activateTool(null);
        } catch (_) {}

        // Ensure placement returns to 1×1 on tab change
        if (typeof setPlacementSize === "function") {
            setPlacementSize("single");
        }
        setSearchQuery("");
        setSelectedModelCategory("All");
        setCategoryScrollIndex(0);
        setHasNavigatedCategories(false);
        setNetNavigationCount(0);
        // Notify other components (e.g., ToolBar) of tab change so they can reset state
        window.dispatchEvent(new Event("blockToolsTabChanged"));
        if (newTab === "blocks") {
            const defaultBlock = blockTypes[0];
            setCurrentBlockType(defaultBlock);
            selectedBlockID = defaultBlock.id;
        } else if (newTab === "models") {
            const defaultEnvModel = environmentModels.find((m) => !m.isCustom);
            console.log("defaultEnvModel", defaultEnvModel);
            if (defaultEnvModel) {
                setCurrentBlockType({
                    ...defaultEnvModel,
                    isEnvironment: true,
                });
                selectedBlockID = defaultEnvModel.id;
            } else {
                setCurrentBlockType(null);
                selectedBlockID = 0;
            }
        } else if (newTab === "components") {
            setCurrentBlockType(null);
            selectedBlockID = 0;
            loadSchematicsFromDB();
            setSelectedComponentID(null);
            try {
                localStorage.removeItem("selectedComponentId");
            } catch (_) {}
        }
        setActiveTab(newTab);
    };

    const handleEnvironmentSelect = (envType) => {
        console.log("Environment selected:", envType);
        // Keep Terrain tool active while changing blocks; deactivate others
        try {
            const manager = terrainBuilderRef?.current?.toolManagerRef?.current;
            const activeToolInstance = manager?.getActiveTool?.();
            const activeToolName = activeToolInstance?.name;
            if (activeToolName && activeToolName !== "terrain") {
                terrainBuilderRef?.current?.activateTool(null);
            }
        } catch (_) {
            terrainBuilderRef?.current?.activateTool(null);
        }
        setCurrentBlockType({
            ...envType,
            isEnvironment: true,
        });
        selectedBlockID = envType.id;
    };

    const handleBlockSelect = (blockType) => {
        console.log("Block selected:", blockType);
        // Keep Terrain tool active while changing blocks; deactivate others
        try {
            const manager = terrainBuilderRef?.current?.toolManagerRef?.current;
            const activeToolInstance = manager?.getActiveTool?.();
            const activeToolName = activeToolInstance?.name;
            if (activeToolName && activeToolName !== "terrain") {
                terrainBuilderRef?.current?.activateTool(null);
            }
        } catch (_) {
            terrainBuilderRef?.current?.activateTool(null);
        }
        setCurrentBlockType({
            ...blockType,
            isEnvironment: false,
        });
        selectedBlockID = blockType.id;
    };

    /** @param {import("./AIAssistantPanel").SchematicHistoryEntry} schematicEntry */
    const handleSchematicSelect = (schematicEntry) => {
        console.log("Schematic selected:", schematicEntry.prompt);
        setCurrentBlockType({
            ...schematicEntry,
            isComponent: true,
        });
        onLoadSchematicFromHistory(schematicEntry.schematic);
        setSelectedComponentID(schematicEntry.id);
        try {
            localStorage.setItem("selectedComponentId", schematicEntry.id);
        } catch (_) {}
    };

    // Category navigation functions
    const getAllCategories = () => {
        const categories = Array.from(
            new Set(environmentModels.map((m) => m.category || "Misc"))
        ).sort();
        const fullList = ["All", ...categories, "Custom"];
        return fullList.filter((v, i, a) => a.indexOf(v) === i);
    };

    const navigateCategories = (direction) => {
        const categories = getAllCategories();
        const visibleCount = 2; // Number of categories to show at once
        const stepSize = visibleCount; // Move by full visible width (90-100%)
        const maxIndex = Math.max(0, categories.length - visibleCount);

        if (direction === "left") {
            // Only allow left navigation if we have net forward progress
            if (netNavigationCount > 0) {
                setNetNavigationCount((prev) => prev - 1);
                setCategoryScrollIndex((prev) => {
                    const newIndex = prev - stepSize;
                    return Math.max(0, newIndex);
                });
            }
        } else {
            // Only allow right navigation if we haven't reached the end
            if (categoryScrollIndex < maxIndex) {
                setHasNavigatedCategories(true); // Mark that we've navigated
                setNetNavigationCount((prev) => prev + 1);
                setCategoryScrollIndex((prev) => {
                    const newIndex = prev + stepSize;
                    return Math.min(maxIndex, newIndex);
                });
            }
        }
    };

    // Get categories for display - no more repetitions
    const getCategoriesForDisplay = () => {
        return getAllCategories();
    };

    const getVisibleCategories = () => {
        const categories = getAllCategories();
        const visibleCount = 2;
        return categories.slice(
            categoryScrollIndex,
            categoryScrollIndex + visibleCount
        );
    };

    const handleCustomAssetDropUpload = async (e) => {
        e.preventDefault();
        e.currentTarget.classList.remove("drag-over");
        const files = Array.from(e.dataTransfer.files);
        if (activeTab === "blocks") {
            // Helper: convert Blob to data URL
            const blobToDataUrl = (blob) =>
                new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });

            // First, handle ZIP files that may contain multi-texture blocks
            const zipFiles = files.filter(
                (file) =>
                    file.name.toLowerCase().endsWith(".zip") ||
                    file.type === "application/zip" ||
                    file.type === "application/x-zip-compressed"
            );

            if (zipFiles.length > 0) {
                try {
                    const allBlocksFromZips = [];
                    for (const zipFile of zipFiles) {
                        try {
                            const zip = await JSZip.loadAsync(zipFile);
                            // Group face files by their immediate parent directory
                            /** @type {Map<string, Record<string, import('jszip').JSZipObject>>} */
                            const dirToFacesMap = new Map();
                            const faceRegex = /(^|\/)\s*([+\-][xyz])\.png$/i;
                            zip.forEach((relativePath, zipEntry) => {
                                if (zipEntry.dir) return;
                                const match = relativePath.match(faceRegex);
                                if (!match) return;
                                const faceKey = match[2].toLowerCase(); // +x, -y, etc
                                // Determine the directory containing the face file
                                const lastSlash = relativePath.lastIndexOf("/");
                                const dirPath =
                                    lastSlash >= 0
                                        ? relativePath.substring(0, lastSlash)
                                        : "";
                                if (!dirToFacesMap.has(dirPath))
                                    dirToFacesMap.set(dirPath, {});
                                dirToFacesMap.get(dirPath)[faceKey] = zipEntry;
                            });

                            // Build blocks for any directory that contains all six faces
                            const requiredFaces = [
                                "+x",
                                "-x",
                                "+y",
                                "-y",
                                "+z",
                                "-z",
                            ];
                            for (const [
                                dirPath,
                                faces,
                            ] of dirToFacesMap.entries()) {
                                const hasAllFaces = requiredFaces.every(
                                    (f) => !!faces[f]
                                );
                                if (!hasAllFaces) continue;

                                // Derive block name from the final folder name
                                const parts = dirPath
                                    .split("/")
                                    .filter(Boolean);
                                const folderName =
                                    parts.length > 0
                                        ? parts[parts.length - 1]
                                        : "Untitled";

                                // Read each face as data URL
                                const sideTextures = {};
                                for (const faceKey of requiredFaces) {
                                    try {
                                        let blob = await faces[faceKey].async(
                                            "blob"
                                        );
                                        if (
                                            !blob.type ||
                                            blob.type ===
                                                "application/octet-stream"
                                        ) {
                                            blob = new Blob([blob], {
                                                type: "image/png",
                                            });
                                        }
                                        sideTextures[faceKey] =
                                            await blobToDataUrl(blob);
                                    } catch (err) {
                                        console.warn(
                                            `Failed to read face ${faceKey} for ${folderName}`,
                                            err
                                        );
                                    }
                                }

                                // Use +y as the primary texture (fallback to any available)
                                const textureUri =
                                    sideTextures["+y"] ||
                                    sideTextures["-y"] ||
                                    sideTextures["+x"] ||
                                    sideTextures["-x"] ||
                                    sideTextures["+z"] ||
                                    sideTextures["-z"] ||
                                    null;

                                allBlocksFromZips.push({
                                    // ID omitted so BlockTypesManager assigns next available (>=100)
                                    name: folderName,
                                    textureUri,
                                    sideTextures,
                                    isCustom: true,
                                    isMultiTexture: true,
                                });
                            }
                        } catch (zipErr) {
                            console.error(
                                "Error processing ZIP for multi-texture blocks:",
                                zipErr
                            );
                        }
                    }

                    if (allBlocksFromZips.length > 0) {
                        try {
                            await batchProcessCustomBlocks(allBlocksFromZips);
                            const updatedCustomBlocksFromZip =
                                getCustomBlocks();
                            await DatabaseManager.saveData(
                                STORES.CUSTOM_BLOCKS,
                                "blocks",
                                updatedCustomBlocksFromZip
                            );
                            refreshBlockTools();
                        } catch (saveZipErr) {
                            console.error(
                                "Error saving custom blocks from ZIP:",
                                saveZipErr
                            );
                        }
                    }
                } catch (outerZipErr) {
                    console.error("ZIP handling error:", outerZipErr);
                }
            }

            const imageFiles = files.filter((file) =>
                file.type.startsWith("image/")
            );
            if (imageFiles.length > 0) {
                if (imageFiles.length > 1) {
                    try {
                        const blockPromises = imageFiles.map((file) => {
                            return new Promise((resolve) => {
                                const reader = new FileReader();
                                reader.onload = () => {
                                    const blockName = file.name.replace(
                                        /\.[^/.]+$/,
                                        ""
                                    );
                                    resolve({
                                        name: blockName,
                                        textureUri: reader.result,
                                    });
                                };
                                reader.readAsDataURL(file);
                            });
                        });
                        const blocks = await Promise.all(blockPromises);
                        await batchProcessCustomBlocks(blocks);
                        const updatedCustomBlocks = getCustomBlocks();
                        await DatabaseManager.saveData(
                            STORES.CUSTOM_BLOCKS,
                            "blocks",
                            updatedCustomBlocks
                        );
                        refreshBlockTools();
                    } catch (error) {
                        console.error(
                            "Error in batch processing custom blocks:",
                            error
                        );
                    }
                } else {
                    const filePromises = imageFiles.map((file) => {
                        return new Promise((resolve) => {
                            const reader = new FileReader();
                            reader.onload = () => {
                                const blockName = file.name.replace(
                                    /\.[^/.]+$/,
                                    ""
                                );
                                const block = {
                                    name: blockName,
                                    textureUri: reader.result,
                                };
                                processCustomBlock(block);
                                resolve();
                            };
                            reader.readAsDataURL(file);
                        });
                    });
                    await Promise.all(filePromises);
                    try {
                        const updatedCustomBlocks = getCustomBlocks();
                        await DatabaseManager.saveData(
                            STORES.CUSTOM_BLOCKS,
                            "blocks",
                            updatedCustomBlocks
                        );
                    } catch (error) {
                        console.error(
                            "Error saving custom blocks to database:",
                            error
                        );
                    }
                    refreshBlockTools();
                }
            }
        } else if (activeTab === "models") {
            const modelFiles = files.filter(
                (file) =>
                    file.name.endsWith(".gltf") || file.name.endsWith(".glb")
            );
            if (modelFiles.length > 0) {
                const existingModels =
                    (await DatabaseManager.getData(
                        STORES.CUSTOM_MODELS,
                        "models"
                    )) || [];
                const existingModelNames = new Set(
                    environmentModels.map((m) => m.name.toLowerCase())
                );
                const newModelsForDB = [];
                const newModelsForUI = [];
                const duplicateFileNames = new Set();
                const processedFileNames = new Set();
                const fileReadPromises = modelFiles.map((file) => {
                    return new Promise((resolve, reject) => {
                        const fileName = file.name.replace(/\.[^/.]+$/, "");
                        const lowerCaseFileName = fileName.toLowerCase();
                        if (existingModelNames.has(lowerCaseFileName)) {
                            duplicateFileNames.add(fileName);
                            console.warn(
                                `Duplicate model skipped: ${fileName} (already exists)`
                            );
                            reject(new Error(`Duplicate model: ${fileName}`));
                            return;
                        }
                        if (processedFileNames.has(lowerCaseFileName)) {
                            duplicateFileNames.add(fileName);
                            console.warn(
                                `Duplicate model skipped: ${fileName} (in current batch)`
                            );
                            reject(
                                new Error(
                                    `Duplicate model in batch: ${fileName}`
                                )
                            );
                            return;
                        }
                        processedFileNames.add(lowerCaseFileName);
                        const reader = new FileReader();
                        reader.onload = () =>
                            resolve({ file, fileName, data: reader.result });
                        reader.onerror = (error) => reject(error);
                        reader.readAsArrayBuffer(file);
                    });
                });
                const results = await Promise.allSettled(fileReadPromises);
                if (duplicateFileNames.size > 0) {
                    alert(
                        `The following model names already exist or were duplicated in the drop:\n- ${Array.from(
                            duplicateFileNames
                        ).join(
                            "\n- "
                        )}\n\nPlease rename the files and try again.`
                    );
                }
                results.forEach((result) => {
                    if (result.status === "fulfilled") {
                        const { file, fileName, data } = result.value;
                        try {
                            const modelDataForDB = {
                                name: fileName,
                                data: data,
                                timestamp: Date.now(),
                            };
                            newModelsForDB.push(modelDataForDB);
                            const blob = new Blob([data], {
                                type: file.type || "model/gltf-binary",
                            });
                            const fileUrl = URL.createObjectURL(blob);
                            const newEnvironmentModel = {
                                id:
                                    Math.max(
                                        0,
                                        ...environmentModels
                                            .filter((model) => model.isCustom)
                                            .map((model) => model.id),
                                        299
                                    ) +
                                    1 +
                                    newModelsForUI.length,
                                name: fileName,
                                modelUrl: fileUrl,
                                isEnvironment: true,
                                isCustom: true,
                                animations: ["idle"],
                            };
                            newModelsForUI.push(newEnvironmentModel);
                        } catch (error) {
                            console.error(
                                `Error processing model ${fileName}:`,
                                error
                            );
                        }
                    } else {
                        console.error(
                            "Failed to process a model file:",
                            result.reason?.message || result.reason
                        );
                    }
                });
                if (newModelsForDB.length > 0) {
                    try {
                        const updatedModelsForDB = [
                            ...existingModels,
                            ...newModelsForDB,
                        ];
                        await DatabaseManager.saveData(
                            STORES.CUSTOM_MODELS,
                            "models",
                            updatedModelsForDB
                        );
                        console.log(
                            `Saved ${newModelsForDB.length} new models to DB.`
                        );
                        environmentModels.push(...newModelsForUI);
                        if (environmentBuilder && environmentBuilder.current) {
                            for (const model of newModelsForUI) {
                                try {
                                    await environmentBuilder.current.loadModel(
                                        model.modelUrl
                                    );
                                    console.log(
                                        `Custom model ${model.name} added and loaded.`
                                    );
                                } catch (loadError) {
                                    console.error(
                                        `Error loading model ${model.name} into environment:`,
                                        loadError
                                    );
                                }
                            }
                        }
                        refreshBlockTools();
                    } catch (error) {
                        console.error(
                            "Error saving or loading new models:",
                            error
                        );
                        alert(
                            "An error occurred while saving or loading the new models. Check the console for details."
                        );
                    }
                } else if (
                    duplicateFileNames.size === 0 &&
                    modelFiles.length > 0
                ) {
                    alert(
                        "Could not process any of the dropped model files. Check the console for errors."
                    );
                }
            }
        }
    };

    const handleDropzoneClick = () => {
        if (fileInputRef.current) {
            fileInputRef.current.click();
        }
    };

    const handleComponentsDropzoneClick = () => {
        if (bpFileInputRef.current) {
            bpFileInputRef.current.click();
        }
    };

    const handleFileInputChange = async (e) => {
        const files = Array.from(e.target.files);
        if (files.length > 0) {
            // Create a synthetic event object similar to drag and drop
            const syntheticEvent = {
                preventDefault: () => {},
                currentTarget: {
                    classList: {
                        remove: () => {},
                    },
                },
                dataTransfer: {
                    files: files,
                },
            };
            await handleCustomAssetDropUpload(syntheticEvent);
            // Reset the file input so the same file can be selected again if needed
            e.target.value = "";
        }
    };

    const readFileAsArrayBuffer = (file) =>
        new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });

    const parseNbtBrowser = async (arrayBuffer) => {
        // Use in-repo browser-safe NBT parser (no Node polyfills)
        // Preserve slice by passing Uint8Array directly when available
        if (arrayBuffer instanceof Uint8Array) {
            return NBTParser.parse(arrayBuffer);
        }
        if (arrayBuffer instanceof ArrayBuffer) {
            return NBTParser.parse(new Uint8Array(arrayBuffer));
        }
        if (arrayBuffer && arrayBuffer.buffer instanceof ArrayBuffer) {
            return NBTParser.parse(new Uint8Array(arrayBuffer.buffer));
        }
        return NBTParser.parse(arrayBuffer);
    };

    const decodeLongPairToBigInt = (pair) => {
        const hi = BigInt((pair[0] >>> 0) >>> 0);
        const lo = BigInt((pair[1] >>> 0) >>> 0);
        return (hi << 32n) | lo;
    };

    const decodePaletteIndices = (longPairs, paletteLen, totalBlocks) => {
        // Normalize to array of 64-bit BigInts
        const longs =
            longPairs &&
            longPairs.length > 0 &&
            typeof longPairs[0] === "bigint"
                ? longPairs
                : (longPairs || []).map(decodeLongPairToBigInt);

        // Mojang encoding packs floor(64 / b) values per 64-bit word. Values do not cross 64-bit boundaries
        const bitsPerBlock = Math.max(
            4,
            Math.ceil(Math.log2(Math.max(1, paletteLen)))
        );
        const valuesPerLong = Math.max(1, Math.floor(64 / bitsPerBlock));
        const mask = (1n << BigInt(bitsPerBlock)) - 1n;

        const out = new Array(totalBlocks);
        for (let i = 0; i < totalBlocks; i++) {
            const longIndex = Math.floor(i / valuesPerLong);
            const indexWithinLong = i % valuesPerLong;
            const startBit = BigInt(indexWithinLong * bitsPerBlock);
            const word = longs[longIndex] ?? 0n;
            out[i] = Number((word >> startBit) & mask);
        }
        return out;
    };

    // Axiom blueprint format uses X-Z-Y order (X changes fastest)
    // This is different from vanilla Minecraft's Y-Z-X order
    const sectionIndexToLocalXYZ = (index) => {
        const x = index & 15;
        const z = (index >> 4) & 15;
        const y = (index >> 8) & 15;
        return { x, y, z };
    };

    const parseAxiomBpInBrowser = async (file) => {
        const ab = await readFileAsArrayBuffer(file);
        const bytes = new Uint8Array(ab);
        const dv = new DataView(bytes.buffer);
        let offset = 0;
        // Magic
        if (
            !(
                bytes[0] === 0x0a &&
                bytes[1] === 0xe5 &&
                bytes[2] === 0xbb &&
                bytes[3] === 0x36
            )
        ) {
            throw new Error("Invalid .bp magic");
        }
        offset += 4;
        if (DEBUG_BP_IMPORT) {
            console.groupCollapsed("[BP] Header");
            console.log("magic:", [...bytes.slice(0, 4)]);
            console.groupEnd();
        }
        // metadata
        const metaLen = dv.getUint32(offset);
        offset += 4;
        const metaBuf = bytes.subarray(offset, offset + metaLen);
        offset += metaLen;
        const metadata = await parseNbtBrowser(metaBuf);
        if (DEBUG_BP_IMPORT) {
            console.groupCollapsed("[BP] Metadata");
            try {
                const keys = Object.keys(metadata || {});
                console.log("keys:", keys);
                console.log("Name:", metadata?.Name?.value || metadata?.Name);
            } catch {}
            console.groupEnd();
        }
        // preview
        const previewLen = dv.getUint32(offset);
        offset += 4;
        const previewBuf = bytes.subarray(offset, offset + previewLen);
        offset += previewLen;
        // structure (gzip NBT)
        const structLen = dv.getUint32(offset);
        offset += 4;
        const structCompressed = bytes.subarray(offset, offset + structLen);
        let structure;
        try {
            const structInflated = pako.ungzip(structCompressed);
            structure = await parseNbtBrowser(structInflated);
            if (DEBUG_BP_IMPORT) {
                console.groupCollapsed("[BP] Structure: gzip decompressed");
                console.log("inflated bytes:", structInflated.byteLength);
                console.log("first 8 bytes:", [...structInflated.slice(0, 8)]);
                console.groupEnd();
            }
        } catch (e) {
            // Some files may have raw NBT without gzip
            structure = await parseNbtBrowser(structCompressed);
            if (DEBUG_BP_IMPORT) {
                console.groupCollapsed("[BP] Structure: raw parse fallback");
                console.log("raw bytes:", structCompressed.byteLength);
                console.log("first 8 bytes:", [
                    ...structCompressed.slice(0, 8),
                ]);
                console.groupEnd();
            }
        }
        return { metadata, previewBuf, structure };
    };

    // Persistent Minecraft block mapping overrides
    const MAPPING_STORAGE_KEY = "axiomBlockMappings";
    const loadSavedMappings = () => {
        try {
            const raw = localStorage.getItem(MAPPING_STORAGE_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch (_) {
            return {};
        }
    };

    const convertStructureToTerrainMap = (structure, customMappings = {}) => {
        // Support both prismarine-nbt shape and NBTParser shape
        const getVal = (v) => (v && v.value !== undefined ? v.value : v);
        let regions = [];
        if (Array.isArray(structure.BlockRegion)) {
            regions = structure.BlockRegion;
        } else if (
            structure.BlockRegion &&
            structure.BlockRegion.value &&
            structure.BlockRegion.value.value
        ) {
            regions = structure.BlockRegion.value.value;
        }
        if (DEBUG_BP_IMPORT) {
            console.groupCollapsed("[BP] BlockRegion summary");
            console.log("regions count:", regions.length);
            console.groupEnd();
        }
        const terrain = {};
        const entities = [];
        for (let idx = 0; idx < regions.length; idx++) {
            const region = regions[idx];
            const baseX = getVal(region.X) * 16;
            const baseY = getVal(region.Y) * 16;
            const baseZ = getVal(region.Z) * 16;
            const bs = getVal(region.BlockStates);
            if (!bs) continue;
            let data = getVal(bs.data) || [];
            let palette = getVal(bs.palette) || [];
            if (palette && palette.value && palette.value.value) {
                palette = palette.value.value;
            }
            if (!palette.length) continue;
            const totalBlocks = 16 * 16 * 16;
            const indices = decodePaletteIndices(
                data,
                palette.length,
                totalBlocks
            );
            if (DEBUG_BP_IMPORT) {
                console.groupCollapsed(
                    `[BP] Region #${idx} @(${baseX},${baseY},${baseZ})`
                );
                console.log("palette length:", palette.length);
                console.log(
                    "bitsPerBlock:",
                    Math.max(
                        4,
                        Math.ceil(Math.log2(Math.max(1, palette.length)))
                    )
                );
                try {
                    const names = palette
                        .slice(0, 10)
                        .map((p) => getVal(p?.Name) || "?");
                    console.log("palette sample:", names);
                } catch {}
                console.groupEnd();
            }
            for (let i = 0; i < totalBlocks; i++) {
                const pIdx = indices[i];
                const entry = palette[pIdx];
                if (!entry) continue;
                const nameVal = getVal(entry.Name);
                if (!nameVal || typeof nameVal !== "string") continue;
                const mcName = nameVal;
                // Use custom mappings if provided, otherwise fall back to default
                const mapping =
                    customMappings[mcName] || suggestMapping(mcName);
                if (!mapping || mapping.action === "skip") continue;

                // Support environment entity placement mapping
                if (mapping.action === "entity") {
                    const { x: lx, y: ly, z: lz } = sectionIndexToLocalXYZ(i);
                    const x = baseX + lx;
                    const y = baseY + ly;
                    const z = baseZ + lz;
                    const entityName = mapping.entityName;
                    entities.push({
                        entityName,
                        position: [x, y, z],
                        rotation: [0, 0, 0],
                    });
                    continue;
                }

                const blockId = parseInt(
                    mapping.id || mapping.targetBlockId || mapping?.id,
                    10
                );
                if (!blockId) continue;

                const { x: lx, y: ly, z: lz } = sectionIndexToLocalXYZ(i);
                const x = baseX + lx;
                const y = baseY + ly;
                const z = baseZ + lz;
                terrain[`${x},${y},${z}`] = blockId;
            }
        }
        if (DEBUG_BP_IMPORT) {
            console.groupCollapsed("[BP] Terrain map summary");
            console.log("Total blocks:", Object.keys(terrain).length);
            const bbox = (map) => {
                const keys = Object.keys(map);
                if (!keys.length) return null;
                let minX = Infinity,
                    minY = Infinity,
                    minZ = Infinity,
                    maxX = -Infinity,
                    maxY = -Infinity,
                    maxZ = -Infinity;
                for (const k of keys) {
                    const [x, y, z] = k.split(",").map(Number);
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (z < minZ) minZ = z;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                    if (z > maxZ) maxZ = z;
                }
                return { minX, minY, minZ, maxX, maxY, maxZ };
            };
            console.log("bbox:", bbox(terrain));
            console.groupEnd();
        }
        return { terrain, entities };
    };

    const terrainToRelativeSchematic = (terrainMap) => {
        const keys = Object.keys(terrainMap);
        if (keys.length === 0) return { blocks: {}, entities: [] };
        let minX = Infinity,
            minY = Infinity,
            minZ = Infinity;
        for (const k of keys) {
            const [x, y, z] = k.split(",").map(Number);
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
        }
        const relBlocks = {};
        for (const [k, id] of Object.entries(terrainMap)) {
            const [x, y, z] = k.split(",").map(Number);
            const rx = x - minX;
            const ry = y - minY;
            const rz = z - minZ;
            relBlocks[`${rx},${ry},${rz}`] = id;
        }
        return {
            blocks: relBlocks,
            entities: [],
            min: { x: minX, y: minY, z: minZ },
        };
    };

    const extractUnmappedBlocks = (structure) => {
        const getVal = (v) => (v && v.value !== undefined ? v.value : v);
        let regions = [];
        if (Array.isArray(structure.BlockRegion)) {
            regions = structure.BlockRegion;
        } else if (
            structure.BlockRegion &&
            structure.BlockRegion.value &&
            structure.BlockRegion.value.value
        ) {
            regions = structure.BlockRegion.value.value;
        }

        const blockCounts = {};
        const unmappedBlocks = new Set();

        for (const region of regions) {
            const bs = getVal(region.BlockStates);
            if (!bs) continue;

            let palette = getVal(bs.palette) || [];
            if (palette && palette.value && palette.value.value) {
                palette = palette.value.value;
            }

            let data = getVal(bs.data) || [];
            const totalBlocks = 16 * 16 * 16;
            const indices = decodePaletteIndices(
                data,
                palette.length,
                totalBlocks
            );

            for (let i = 0; i < totalBlocks; i++) {
                const pIdx = indices[i];
                const entry = palette[pIdx];
                if (!entry) continue;

                const nameVal = getVal(entry.Name);
                if (!nameVal || typeof nameVal !== "string") continue;

                const mcName = nameVal;
                blockCounts[mcName] = (blockCounts[mcName] || 0) + 1;

                // Check if this block doesn't have a default mapping
                if (!DEFAULT_BLOCK_MAPPINGS[mcName]) {
                    const suggested = suggestMapping(mcName);
                    if (!suggested || suggested.action === "skip") {
                        unmappedBlocks.add(mcName);
                    }
                }
            }
        }

        return {
            unmappedBlocks: Array.from(unmappedBlocks),
            blockCounts,
        };
    };

    const handleBlockMappingConfirm = (customMappings) => {
        if (!pendingBpImport) return;

        const { metadata, structure, file } = pendingBpImport;
        const saved = loadSavedMappings();
        const mergedMappings = { ...saved, ...customMappings };
        const { terrain, entities } = convertStructureToTerrainMap(
            structure,
            mergedMappings
        );
        const schematic = terrainToRelativeSchematic(terrain);
        if (entities && entities.length) {
            schematic.entities = entities.map((e) => ({
                entityName: e.entityName,
                position: [
                    e.position[0] - schematic.min.x,
                    e.position[1] - schematic.min.y,
                    e.position[2] - schematic.min.z,
                ],
                rotation: e.rotation,
            }));
        }

        if (DEBUG_BP_IMPORT) {
            console.groupCollapsed("[BP] Import with custom mappings");
            console.log("Custom mappings:", customMappings);
            console.log(
                "Block count:",
                Object.keys(schematic.blocks || {}).length
            );
            console.groupEnd();
        }

        const nameTag =
            metadata && metadata.Name && (metadata.Name.value || metadata.Name);
        const name =
            typeof nameTag === "string" && nameTag.trim()
                ? nameTag
                : file.name.replace(/\.bp$/i, "");

        const entry = {
            id: `bp-${Date.now()}`,
            prompt: `Imported BP: ${name}`,
            name,
            schematic,
            timestamp: Date.now(),
        };

        try {
            DatabaseManager.saveData(STORES.SCHEMATICS, entry.id, entry)
                .then(() =>
                    window.dispatchEvent(new Event("schematicsDbUpdated"))
                )
                .catch((dbErr) =>
                    console.warn("Failed to save schematic to DB:", dbErr)
                );
        } catch (_) {}

        try {
            if (terrainBuilderRef?.current?.activateTool) {
                terrainBuilderRef.current.activateTool("schematic", schematic);
            }
        } catch (_) {}

        // Clean up
        setShowBlockRemapper(false);
        setPendingBpImport(null);
        setUnmappedBlocks([]);
        setBlockCounts({});
    };

    const handleBlockMappingCancel = () => {
        setShowBlockRemapper(false);
        setPendingBpImport(null);
        setPendingComponentImport(null);
        setUnmappedBlocks([]);
        setBlockCounts({});
        if (bpFileInputRef.current) {
            bpFileInputRef.current.value = "";
        }
    };

    const primeNameBasedAutoMappings = (names) => {
        try {
            const normalize = (s) =>
                (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
            const byNorm = new Map();
            for (const b of blockTypes) {
                byNorm.set(normalize(b.name), b);
            }
            const STORAGE_KEY = "axiomBlockMappings";
            let saved = {};
            try {
                saved =
                    JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
            } catch (_) {}
            let changed = false;
            for (const name of names) {
                if (saved[name]) continue; // don't override user choice
                const match = byNorm.get(normalize(name));
                if (match) {
                    saved[name] = {
                        action: "map",
                        id: match.id,
                        name: match.name,
                    };
                    changed = true;
                }
            }
            if (changed)
                localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        } catch (_) {}
    };

    const [pendingComponentImport, setPendingComponentImport] = useState(null);

    const handleComponentJsonImport = async (file) => {
        try {
            const text = await file.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch (parseErr) {
                console.error("Invalid JSON in component file:", parseErr);
                alert("Invalid JSON file.");
                return;
            }

            const schematic = data?.schematic || (data?.blocks ? data : null);
            if (!schematic) {
                alert("JSON does not contain a component schematic.");
                return;
            }

            const nameFromFile = file.name.replace(/\.[^/.]+$/, "");
            const name = data?.name || nameFromFile || "Imported Component";
            const blocksMeta = data?.blocksMeta || data?.blockDetails || null;
            if (blocksMeta && typeof blocksMeta === "object") {
                const sourceIdToName = {};
                Object.keys(blocksMeta).forEach((k) => {
                    const info = blocksMeta[k];
                    const nm = (info && (info.name || info.id || k)) + "";
                    sourceIdToName[k] = nm;
                });
                const blocksObj =
                    (schematic && schematic.blocks) || schematic || {};
                const countsByName = {};
                for (const pos in blocksObj) {
                    const sid = blocksObj[pos];
                    const nm = sourceIdToName[String(sid)] || `Block_${sid}`;
                    countsByName[nm] = (countsByName[nm] || 0) + 1;
                }
                const names = Object.keys(countsByName);
                primeNameBasedAutoMappings(names);
                setPendingComponentImport({
                    file,
                    name,
                    prompt: data?.prompt || `Imported Component: ${name}`,
                    schematic,
                    sourceIdToName,
                    countsByName,
                });
                setUnmappedBlocks(names);
                setBlockCounts(countsByName);
                setShowBlockRemapper(true);
            } else {
                const entry = {
                    id: `comp-${Date.now()}`,
                    prompt: data?.prompt || `Imported Component: ${name}`,
                    name,
                    schematic,
                    timestamp: Date.now(),
                };
                try {
                    const blocksForPreview =
                        schematic && schematic.blocks
                            ? schematic.blocks
                            : schematic;
                    const preview = await generateSchematicPreview(
                        blocksForPreview,
                        {
                            width: 48,
                            height: 48,
                            background: "transparent",
                        }
                    );
                    await DatabaseManager.saveData(
                        STORES.PREVIEWS,
                        entry.id,
                        preview
                    );
                    setSchematicPreviews((prev) => ({
                        ...prev,
                        [entry.id]: preview,
                    }));
                } catch (previewErr) {
                    console.warn(
                        "Failed to generate/save preview for imported component:",
                        previewErr
                    );
                }
                await DatabaseManager.saveData(
                    STORES.SCHEMATICS,
                    entry.id,
                    entry
                );
                window.dispatchEvent(new Event("schematicsDbUpdated"));
            }
        } catch (err) {
            console.error("Failed to import component JSON:", err);
            alert("Failed to import component JSON. See console for details.");
        }
    };

    const handleComponentMappingConfirm = async (customMappings) => {
        if (!pendingComponentImport) return;
        const { name, prompt, schematic, sourceIdToName } =
            pendingComponentImport;
        const srcBlocks = (schematic && schematic.blocks) || schematic || {};
        const newBlocks = {};
        const newEntities = [];
        for (const key in srcBlocks) {
            const srcId = srcBlocks[key];
            const nm = sourceIdToName[String(srcId)] || `Block_${srcId}`;
            const m = customMappings[nm];
            if (!m || m.action === "skip") continue;
            if (m.action === "entity" && m.entityName) {
                const [x, y, z] = key
                    .split(",")
                    .map((v) => parseInt(v, 10) || 0);
                newEntities.push({
                    entityName: m.entityName,
                    position: [x, y, z],
                    rotation: [0, 0, 0],
                });
            } else if (m.action === "map" && (m.id || m.targetBlockId)) {
                const targetId = parseInt(m.id || m.targetBlockId, 10);
                if (targetId > 0) newBlocks[key] = targetId;
            }
        }
        const finalSchematic = { ...schematic, blocks: newBlocks };
        if (newEntities.length) finalSchematic.entities = newEntities;
        const entry = {
            id: `comp-${Date.now()}`,
            prompt,
            name,
            schematic: finalSchematic,
            timestamp: Date.now(),
        };
        try {
            const blocksForPreview = finalSchematic.blocks || finalSchematic;
            const preview = await generateSchematicPreview(blocksForPreview, {
                width: 48,
                height: 48,
                background: "transparent",
            });
            await DatabaseManager.saveData(STORES.PREVIEWS, entry.id, preview);
            setSchematicPreviews((prev) => ({ ...prev, [entry.id]: preview }));
        } catch (previewErr) {
            console.warn(
                "Failed to generate/save preview for mapped component:",
                previewErr
            );
        }
        try {
            await DatabaseManager.saveData(STORES.SCHEMATICS, entry.id, entry);
            window.dispatchEvent(new Event("schematicsDbUpdated"));
        } catch (e) {
            console.error("Failed to save mapped component:", e);
        }
        setShowBlockRemapper(false);
        setPendingComponentImport(null);
        setUnmappedBlocks([]);
        setBlockCounts({});
    };

    const handleBpFileInputChange = async (e) => {
        const files = Array.from(e.target.files || []);
        const bp = files.find((f) => f.name.toLowerCase().endsWith(".bp"));
        const json = files.find((f) => f.name.toLowerCase().endsWith(".json"));
        try {
            if (bp) {
                const { metadata, structure } = await parseAxiomBpInBrowser(bp);

                // Check for unmapped blocks
                const { unmappedBlocks, blockCounts } =
                    extractUnmappedBlocks(structure);
                // Apply saved mappings to reduce remap workload
                const saved = loadSavedMappings();
                const remainingUnmapped = unmappedBlocks.filter((name) => {
                    const m = saved[name];
                    if (!m) return true;
                    if (m.action === "map" && (m.id || m.targetBlockId))
                        return false;
                    if (
                        m.action === "entity" &&
                        (m.entityName || m.targetEntityName)
                    )
                        return false;
                    return true;
                });

                // Always show remapper UI, even if all blocks are auto-mapped
                setPendingBpImport({ metadata, structure, file: bp });
                setUnmappedBlocks(remainingUnmapped);
                setBlockCounts(blockCounts);
                setShowBlockRemapper(true);
            } else if (json) {
                await handleComponentJsonImport(json);
            }
        } catch (err) {
            console.error("Import failed:", err);
            alert("Failed to import file. See console for details.");
        } finally {
            e.target.value = "";
        }
    };

    const handleBlueprintDropUpload = async (e) => {
        e.preventDefault();
        e.currentTarget.classList.remove("drag-over");
        const files = Array.from(e.dataTransfer.files || []);
        const bp = files.find((f) => f.name.toLowerCase().endsWith(".bp"));
        const json = files.find((f) => f.name.toLowerCase().endsWith(".json"));
        try {
            if (bp) {
                const { metadata, structure } = await parseAxiomBpInBrowser(bp);

                // Check for unmapped blocks
                const { unmappedBlocks, blockCounts } =
                    extractUnmappedBlocks(structure);
                // Apply saved mappings to reduce remap workload
                const saved = loadSavedMappings();
                const remainingUnmapped = unmappedBlocks.filter((name) => {
                    const m = saved[name];
                    if (!m) return true;
                    if (m.action === "map" && (m.id || m.targetBlockId))
                        return false;
                    if (
                        m.action === "entity" &&
                        (m.entityName || m.targetEntityName)
                    )
                        return false;
                    return true;
                });

                // Always show remapper UI, even if all blocks are auto-mapped
                setPendingBpImport({ metadata, structure, file: bp });
                setUnmappedBlocks(remainingUnmapped);
                setBlockCounts(blockCounts);
                setShowBlockRemapper(true);
            } else if (json) {
                await handleComponentJsonImport(json);
            }
        } catch (err) {
            console.error("Import failed:", err);
            alert("Failed to import file. See console for details.");
        }
    };

    // ---------- Search Filtering ----------
    const normalizedQuery = searchQuery.trim().toLowerCase();

    const isMatch = (str) => {
        if (!normalizedQuery) return true;
        return str && str.toString().toLowerCase().includes(normalizedQuery);
    };

    const visibleDefaultBlocks = blockTypes
        .filter((block) => block.id > 0 && block.id < 1000)
        .filter((block) => isMatch(block.name) || isMatch(block.id));

    const visibleCustomBlocks = customBlocks
        .filter((block) => block.id >= 1000 && block.id < 2000)
        .filter((block) => isMatch(block.name) || isMatch(block.id));

    // --------- Category Filtering Helpers ---------
    const modelCategoryMatch = (envType) => {
        if (selectedModelCategory === "All") return true;
        if (selectedModelCategory === "Custom") return envType.isCustom;
        return envType.category === selectedModelCategory;
    };

    const visibleDefaultModels = environmentModels
        .filter((envType) => !envType.isCustom)
        .filter(modelCategoryMatch)
        .filter((envType) => isMatch(envType.name) || isMatch(envType.id));

    const visibleCustomModels = environmentModels
        .filter((envType) => envType.isCustom)
        .filter(modelCategoryMatch)
        .filter((envType) => isMatch(envType.name) || isMatch(envType.id));

    const visibleSchematics = schematicList.filter((entry) => {
        return (
            isMatch(entry.name) || isMatch(entry.prompt) || isMatch(entry.id)
        );
    });

    return (
        <>
            <div
                className="block-tools-container"
                style={{
                    display: "flex",
                    flexDirection: "column",
                    height: "100%",
                    width: "100%",
                }}
            >
                <div
                    className="block-tools-sidebar transition-all ease-in-out duration-500 bg-[#0d0d0d]/70 backdrop-filter backdrop-blur-lg"
                    style={{
                        width: isCompactMode ? "205px" : "295px",
                    }}
                >
                    <div className="flex w-full tab-button-outer-wrapper">
                        <div
                            className="flex w-full tab-button-inner-wrapper"
                            style={{ width: "100%" }}
                        >
                            {["blocks", "models", "components"].map(
                                (tab, index) => (
                                    <button
                                        key={index}
                                        onClick={() => handleTabChange(tab)}
                                        className={`tab-button w-full ${
                                            activeTab === tab ? "active" : ""
                                        }`}
                                        title={
                                            isCompactMode
                                                ? tab.charAt(0).toUpperCase() +
                                                  tab.slice(1)
                                                : undefined
                                        }
                                    >
                                        {isCompactMode ? (
                                            tab === "blocks" ? (
                                                <BlockIcon className="mx-auto h-4.5 w-4.5" />
                                            ) : tab === "models" ? (
                                                <PalmTreeIcon className="mx-auto h-4.5 w-4.5" />
                                            ) : (
                                                <BlocksIcon className="mx-auto h-4.5 w-4.5" />
                                            )
                                        ) : (
                                            tab
                                        )}
                                    </button>
                                )
                            )}
                            <div
                                className="tab-indicator"
                                style={{
                                    left: `${
                                        activeTab === "blocks"
                                            ? "calc(0%)"
                                            : activeTab === "models"
                                            ? "calc(33.333% + 2px)"
                                            : "calc(66.666% + 4px)"
                                    }`,
                                }}
                            />
                        </div>
                    </div>
                    <div
                        className="block-tools-divider"
                        style={{
                            width: "100%",
                            height: "1px",
                            backgroundColor: "rgba(255, 255, 255, 0.15)",
                            marginBottom: "15px",
                        }}
                    />
                    <div className="px-3">
                        <input
                            type="text"
                            placeholder="Search..."
                            value={searchQuery}
                            onKeyDown={(e) => e.stopPropagation()}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="px-3 py-2 w-full text-xs text-white rounded-md border bg-black/30 border-white/20 focus:outline-none focus:ring-1 focus:ring-white/50 placeholder-white/40"
                        />
                    </div>
                    {activeTab === "models" && (
                        <div className="flex items-center px-3 py-2">
                            <div className="flex items-center w-full">
                                {hasNavigatedCategories &&
                                    netNavigationCount > 0 && (
                                        <button
                                            onClick={() =>
                                                navigateCategories("left")
                                            }
                                            className="flex flex-shrink-0 justify-center items-center mr-2 w-6 h-6 text-white rounded-sm border transition-all cursor-pointer bg-white/10 hover:bg-white/20 border-white/20"
                                            title="Previous categories"
                                        >
                                            <FaChevronLeft className="w-3 h-3" />
                                        </button>
                                    )}

                                <div
                                    className={`flex-1 overflow-hidden ${
                                        hasNavigatedCategories
                                            ? "justify-center"
                                            : "justify-start"
                                    }`}
                                >
                                    <div
                                        className="flex gap-1.5 transition-transform duration-300 ease-in-out"
                                        style={{
                                            transform: `translateX(-${
                                                (categoryScrollIndex / 2) * 120
                                            }px)`, // Translation based on visible count steps
                                        }}
                                    >
                                        {getCategoriesForDisplay().map(
                                            (cat, index) => (
                                                <button
                                                    key={`${cat}-${index}`}
                                                    className={`text-xs cursor-pointer px-2 py-1 rounded-lg border transition-all duration-300 whitespace-nowrap flex-shrink-0 ${
                                                        selectedModelCategory ===
                                                        cat
                                                            ? "bg-white text-black border-white"
                                                            : "bg-white/10 text-white border-white/20 hover:bg-white/20 hover:border-white/40"
                                                    }`}
                                                    onClick={() =>
                                                        setSelectedModelCategory(
                                                            cat
                                                        )
                                                    }
                                                >
                                                    {cat}
                                                </button>
                                            )
                                        )}
                                    </div>
                                </div>

                                {(() => {
                                    const categories = getAllCategories();
                                    const maxIndex = Math.max(
                                        0,
                                        categories.length - 2
                                    );
                                    return (
                                        categoryScrollIndex < maxIndex && (
                                            <button
                                                onClick={() =>
                                                    navigateCategories("right")
                                                }
                                                className="flex flex-shrink-0 justify-center items-center ml-2 w-6 h-6 text-white rounded-sm border transition-all cursor-pointer bg-white/10 hover:bg-white/20 border-white/20"
                                                title="Next categories"
                                            >
                                                <FaChevronRight className="w-3 h-3" />
                                            </button>
                                        )
                                    );
                                })()}
                            </div>
                        </div>
                    )}
                    <div className="block-buttons-grid">
                        {activeTab === "blocks" ? (
                            <>
                                <div className="block-tools-section-label">
                                    Default Blocks (ID: 1-999)
                                </div>
                                {visibleDefaultBlocks.map((blockType) => (
                                    <BlockButton
                                        key={blockType.id}
                                        blockType={blockType}
                                        isSelected={
                                            selectedBlockID === blockType.id
                                        }
                                        onSelect={(block) => {
                                            handleBlockSelect(block);
                                            localStorage.setItem(
                                                "selectedBlock",
                                                block.id
                                            );
                                        }}
                                        handleDragStart={handleDragStart}
                                    />
                                ))}
                                <div className="mt-2 block-tools-section-label custom-label-with-icon">
                                    Custom Blocks (ID: 1000-1999)
                                    <button
                                        className="download-all-icon-button"
                                        onClick={handleDownloadAllCustom}
                                        title="Download all custom textures"
                                    >
                                        {visibleCustomBlocks.length > 0 && (
                                            <FaDownload />
                                        )}
                                    </button>
                                </div>
                                {visibleCustomBlocks.map((blockType) => (
                                    <BlockButton
                                        key={blockType.id}
                                        blockType={blockType}
                                        isSelected={
                                            selectedBlockID === blockType.id
                                        }
                                        onSelect={(block) => {
                                            handleBlockSelect(block);
                                            localStorage.setItem(
                                                "selectedBlock",
                                                block.id
                                            );
                                        }}
                                        handleDragStart={handleDragStart}
                                        needsTexture={blockType.needsTexture}
                                    />
                                ))}
                            </>
                        ) : activeTab === "models" ? (
                            <>
                                <div className="environment-button-wrapper">
                                    <div className="block-tools-section-label">
                                        Default Models (ID: 2000-4999)
                                    </div>
                                    {visibleDefaultModels.map((envType) => (
                                        <EnvironmentButton
                                            key={envType.id}
                                            envType={envType}
                                            isSelected={
                                                selectedBlockID === envType.id
                                            }
                                            onSelect={(envType) => {
                                                handleEnvironmentSelect(
                                                    envType
                                                );
                                                localStorage.setItem(
                                                    "selectedBlock",
                                                    envType.id
                                                );
                                            }}
                                        />
                                    ))}
                                    <div className="mt-2 block-tools-section-label">
                                        Custom Models (ID: 5000+)
                                    </div>
                                    {visibleCustomModels.map((envType) => (
                                        <EnvironmentButton
                                            key={envType.id}
                                            envType={envType}
                                            isSelected={
                                                selectedBlockID === envType.id
                                            }
                                            onSelect={(envType) => {
                                                handleEnvironmentSelect(
                                                    envType
                                                );
                                                localStorage.setItem(
                                                    "selectedBlock",
                                                    envType.id
                                                );
                                            }}
                                        />
                                    ))}
                                </div>
                            </>
                        ) : activeTab === "components" ? (
                            <>
                                <div className="block-tools-section-label custom-label-with-icon">
                                    Saved Components
                                    <button
                                        className="download-all-icon-button"
                                        onClick={handleDownloadAllComponents}
                                        title="Download all components"
                                    >
                                        {visibleSchematics.length > 0 && (
                                            <FaDownload />
                                        )}
                                    </button>
                                    <button
                                        className="download-all-icon-button"
                                        onClick={handleDeleteAllComponents}
                                        title="Delete all components"
                                    >
                                        {visibleSchematics.length > 0 && (
                                            <FaTrash />
                                        )}
                                    </button>
                                </div>
                                {visibleSchematics.length === 0 && (
                                    <div className="no-schematics-text">
                                        No schematics saved yet. Generate some
                                        using the AI Assistant!
                                    </div>
                                )}
                                {visibleSchematics.map((entry) => (
                                    <div
                                        key={entry.id}
                                        className={`border transition-all duration-150 schematic-button bg-white/10 ${
                                            selectedComponentID === entry.id
                                                ? "border-white"
                                                : "border-white/0"
                                        } hover:border-white/20 active:border-white`}
                                        style={{
                                            width: isCompactMode
                                                ? "calc(50% - 6px)"
                                                : "calc(33.333% - 4px)",
                                        }}
                                        onClick={() =>
                                            handleSchematicSelect(entry)
                                        }
                                        title={`Load: ${entry.prompt}`}
                                    >
                                        <div className="schematic-button-icon">
                                            {typeof schematicPreviews[
                                                entry.id
                                            ] === "string" ? (
                                                <img
                                                    src={
                                                        schematicPreviews[
                                                            entry.id
                                                        ]
                                                    }
                                                    alt="Schematic preview"
                                                    style={{
                                                        width: "48px",
                                                        height: "48px",
                                                        objectFit: "contain",
                                                    }}
                                                />
                                            ) : schematicPreviews[entry.id] ===
                                              null ? (
                                                <FaWrench title="Preview unavailable" />
                                            ) : (
                                                <div
                                                    className="schematic-loading-spinner"
                                                    title="Loading preview..."
                                                ></div>
                                            )}
                                        </div>
                                        <div className="schematic-button-prompt">
                                            {entry.name && entry.name.trim()
                                                ? entry.name.length > 50
                                                    ? entry.name.substring(
                                                          0,
                                                          47
                                                      ) + "..."
                                                    : entry.name
                                                : entry.prompt.length > 50
                                                ? entry.prompt.substring(
                                                      0,
                                                      47
                                                  ) + "..."
                                                : entry.prompt}
                                        </div>
                                    </div>
                                ))}
                                <div className="flex px-3 mb-3 w-full">
                                    <input
                                        ref={bpFileInputRef}
                                        type="file"
                                        multiple={false}
                                        accept={
                                            ".bp,.json,application/octet-stream,application/json"
                                        }
                                        onChange={handleBpFileInputChange}
                                        style={{ display: "none" }}
                                    />
                                    <div
                                        className="texture-drop-zone w-full py-2 h-[120px] cursor-pointer"
                                        onDragOver={(e) => {
                                            e.preventDefault();
                                            e.currentTarget.classList.add(
                                                "drag-over"
                                            );
                                        }}
                                        onDragLeave={(e) => {
                                            e.preventDefault();
                                            e.currentTarget.classList.remove(
                                                "drag-over"
                                            );
                                        }}
                                        onDrop={handleBlueprintDropUpload}
                                        onClick={handleComponentsDropzoneClick}
                                    >
                                        <div className="drop-zone-content">
                                            <div className="drop-zone-icons">
                                                <FaUpload />
                                            </div>
                                            <div className="drop-zone-text">
                                                Click or drag Axiom .bp or
                                                component .json to import as
                                                components.
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </>
                        ) : null}
                    </div>

                    {(activeTab === "blocks" || activeTab === "models") && (
                        <div className="flex px-3 mb-3 w-full">
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                accept={
                                    activeTab === "blocks"
                                        ? "image/*,.zip,application/zip,application/x-zip-compressed"
                                        : activeTab === "models"
                                        ? ".gltf,.glb"
                                        : ""
                                }
                                onChange={handleFileInputChange}
                                style={{ display: "none" }}
                            />
                            <div
                                className="texture-drop-zone w-full py-2 h-[120px] cursor-pointer"
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    e.currentTarget.classList.add("drag-over");
                                }}
                                onDragLeave={(e) => {
                                    e.preventDefault();
                                    e.currentTarget.classList.remove(
                                        "drag-over"
                                    );
                                }}
                                onDrop={handleCustomAssetDropUpload}
                                onClick={handleDropzoneClick}
                            >
                                <div className="drop-zone-content">
                                    <div className="drop-zone-icons">
                                        <FaUpload />
                                    </div>
                                    <div className="drop-zone-text">
                                        {activeTab === "blocks"
                                            ? "Click or drag images or .zip (multi-texture) to upload new blocks"
                                            : activeTab === "models"
                                            ? "Click or drag .gltf files to add custom models"
                                            : ""}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                    {activeTab === "blocks" && (
                        <div className="flex px-3 mb-3 w-full">
                            <button
                                className="flex justify-center items-center p-2 w-full font-medium text-center text-black bg-white rounded-md border transition-all cursor-pointer hover:border-2 hover:border-black"
                                onClick={onOpenTextureModal}
                            >
                                Create Texture
                            </button>
                        </div>
                    )}
                </div>
            </div>
            {showBlockRemapper && (
                <AxiomBlockRemapper
                    unmappedBlocks={unmappedBlocks}
                    blockCounts={blockCounts}
                    onConfirmMappings={
                        pendingComponentImport
                            ? handleComponentMappingConfirm
                            : handleBlockMappingConfirm
                    }
                    onCancel={handleBlockMappingCancel}
                />
            )}
        </>
    );
};
export default BlockToolsSidebar;
