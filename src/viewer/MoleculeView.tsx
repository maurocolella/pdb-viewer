import { Suspense, useEffect, useMemo, useState, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, AdaptiveDpr, Preload, Bounds, useBounds } from "@react-three/drei";
import { Leva, useControls } from "leva";
import type { InstancedMesh, LineSegments, Material } from "three";
import { useMolScene } from "./useMolScene";
import { makeAtomsMesh, makeBondLines, makeBackboneLines, makeRibbonMesh, makeFlatRibbonMesh } from "pdb-parser";
import type { ParseOptions, MolScene, AtomMeshOptions, BackboneLineOptions } from "pdb-parser";
import { Mesh, Group, BufferGeometry } from "three";

type SceneBuildOptions = {
  atoms: AtomMeshOptions | false;
  bonds: boolean;
  backbone: BackboneLineOptions | false;
};

function useSceneObjects(scene: MolScene | null, opts: SceneBuildOptions) {
  const objects = useMemo(() => {
    if (!scene) return { atoms: undefined as InstancedMesh | undefined, bonds: undefined as LineSegments | undefined, backbone: undefined as LineSegments | undefined };

    let atoms: InstancedMesh | undefined;
    let bonds: LineSegments | undefined;
    let backbone: LineSegments | undefined;

    if (opts.atoms !== false) {
      atoms = makeAtomsMesh(scene, {
        sphereDetail: opts.atoms?.sphereDetail ?? 16,
        materialKind: (opts.atoms?.materialKind ?? "standard") as AtomMeshOptions["materialKind"],
        radiusScale: opts.atoms?.radiusScale ?? 1.0,
      });
      // Force uniform white material (disable vertex colors), mirroring the earlier fuchsia override but with white.
      if (atoms) {
        const mat = atoms.material as unknown as { vertexColors?: boolean; color?: { set: (v: string) => void }; needsUpdate?: boolean };
        if (typeof mat.vertexColors !== "undefined") mat.vertexColors = false;
        if (mat.color) mat.color.set("#ffffff");
        if (typeof mat.needsUpdate !== "undefined") mat.needsUpdate = true;
      }
    }
    if (opts.bonds) {
      bonds = makeBondLines(scene) as LineSegments | undefined;
    }
    if (opts.backbone !== false) {
      backbone = makeBackboneLines(scene, { color: opts.backbone?.color ?? 0xffffff }) as LineSegments | undefined;
    }

    return { atoms, bonds, backbone };
  }, [scene, opts.atoms, opts.bonds, opts.backbone]);

  // dispose on change/unmount
  useEffect(() => {
    return () => {
      objects.atoms?.geometry.dispose();
      (objects.atoms?.material as Material | undefined)?.dispose?.();
      objects.bonds?.geometry.dispose();
      (objects.bonds?.material as Material | undefined)?.dispose?.();
      objects.backbone?.geometry.dispose();
      (objects.backbone?.material as Material | undefined)?.dispose?.();
    };
  }, [objects.atoms, objects.bonds, objects.backbone]);

  return objects;
}

export function MoleculeView() {
  // Controls: parsing + rendering
  const [sourceUrl, setSourceUrl] = useState<string>("/models/1IGY.pdb");

  const parseOpts = useControls("Parse", {
    altLocPolicy: { value: "occupancy", options: ["occupancy", "all"] as ParseOptions["altLocPolicy"][] },
    modelSelection: { value: 1, min: 1, step: 1 },
    bondPolicy: { value: "conect+heuristic", options: ["conect-only", "heuristic-if-missing", "conect+heuristic"] as ParseOptions["bondPolicy"][] },
  });

  // Common controls
  const common = useControls("Common", {
    representation: { value: "spheres", options: ["spheres", "ribbon-tube", "ribbon-flat"] as const },
    materialKind: { value: "standard", options: ["basic", "lambert", "standard"] as const },
    background: { value: "#111111" },
  });

  // Overlays (apply across modes)
  const overlays = useControls("Overlays", {
    atoms: {
      value: true,
      render: (get) => get("Common.representation") === "spheres",
    },
    bonds: true,
    backbone: {
      value: true,
      render: (get) => get("Common.representation") === "spheres",
    },
  });

  // Spheres-only controls
  const spheres = useControls("Spheres", {
    sphereDetail: {
      value: 16, min: 4, max: 32, step: 2,
      render: (get) => get("Common.representation") === "spheres",
    },
    radiusScale: {
      value: 0.3, min: 0.05, max: 2.0, step: 0.05,
      render: (get) => get("Common.representation") === "spheres",
    },
  });

  // Ribbon-only controls
  const ribbon = useControls("Ribbon", {
    thickness: {
      value: 0.18, min: 0.02, max: 0.6, step: 0.01,
      render: (get) => get("Common.representation") === "ribbon-flat",
    },
  });

  const { scene, error, loading } = useMolScene(sourceUrl, parseOpts as ParseOptions);
  const objects = useSceneObjects(scene, {
    atoms: overlays.atoms && common.representation === "spheres"
      ? { sphereDetail: spheres.sphereDetail, materialKind: common.materialKind as AtomMeshOptions["materialKind"], radiusScale: spheres.radiusScale }
      : false,
    bonds: overlays.bonds,
    backbone: overlays.backbone && common.representation === "spheres" ? {} : false,
  });

  // Build cartoon (ribbon) group only when selected
  const cartoon = useMemo(() => {
    if (!scene) return null;
    if (common.representation === "ribbon-tube") {
      return makeRibbonMesh(scene, {
        radius: 0.4,
        radialSegments: 12,
        tubularSegmentsPerPoint: 6,
        materialKind: common.materialKind as AtomMeshOptions["materialKind"],
        color: 0xffffff,
      });
    }
    if (common.representation === "ribbon-flat") {
      return makeFlatRibbonMesh(scene, {
        width: 1.2,
        segmentsPerPoint: 6,
        materialKind: common.materialKind as AtomMeshOptions["materialKind"],
        color: 0xffffff,
        doubleSided: true,
        thickness: ribbon.thickness,
      });
    }
    return null;
  }, [scene, common.representation, common.materialKind, ribbon.thickness]);

  // Dispose cartoon on change/unmount
  useEffect(() => {
    return () => {
      if (!cartoon) return;
      cartoon.traverse((obj) => {
        if (obj instanceof Mesh) {
          // geometry is BufferGeometry on Mesh
          obj.geometry.dispose();
          const m = obj.material;
          if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
          else m.dispose();
        }
      });
    };
  }, [cartoon]);

  useEffect(() => {
    document.body.style.background = common.background;
  }, [common.background]);

  // Fit camera once after scene content mounts (no ongoing observe)
  const api = useBounds();
  const did = useRef(false);
  const contentRef = useRef<Group | null>(null);
  useEffect(() => {
    if (did.current) return;
    const t = setTimeout(() => {
      try { api.refresh().fit(); } catch { /* ignore initial fit errors */ }
      did.current = true;
    }, 0);
    return () => clearTimeout(t);
  }, [api]);

  // Re-center only when a new sourceUrl is loaded (do not react to Leva changes)
  const lastFittedSource = useRef<string | null>(null);
  useEffect(() => {
    if (!scene || loading) return; // wait until parsing finishes
    if (lastFittedSource.current === sourceUrl) return;
    let raf1 = 0, raf2 = 0, raf3 = 0;
    const doFit = () => {
      try {
        const root = contentRef.current;
        if (root) {
          // Ensure children exist before measuring
          if (root.children.length === 0) {
            raf3 = requestAnimationFrame(doFit);
            return;
          }
          root.traverse((obj) => {
            if (obj instanceof Mesh) {
              const g = obj.geometry as BufferGeometry;
              g.computeBoundingBox();
              g.computeBoundingSphere();
            }
          });
          api.refresh(root).fit();
        } else {
          api.refresh().fit();
        }
        lastFittedSource.current = sourceUrl;
      } catch { /* ignore fit errors on model swap */ }
    };
    // Double-RAF to wait for commit, plus a child-presence check above
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(doFit);
    });
    return () => {
      if (raf1) cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      if (raf3) cancelAnimationFrame(raf3);
    };
  }, [scene, sourceUrl, loading, api]);

  return (
    <div style={{ display: 'flex', height: '100%', flex: 1 }}>
      <Leva collapsed={false} oneLineLabels hideCopyButton />
      <div style={{ position: "absolute", top: 10, left: 10, zIndex: 1 }}>
        <input
          type="text"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="/models/1IGY.pdb or URL"
          style={{ width: 320, padding: 10, background: "#222", color: "#eee", border: "1px solid #444", borderRadius: 4 }}
        />
      </div>
      <Canvas
        gl={{ antialias: true }}
        dpr={[1, Math.min(window.devicePixelRatio || 1, 2)]}
        camera={{ position: [0, 0, 100], near: 0.1, far: 5000 }}
      >
        <color attach="background" args={[common.background]} />
        <ambientLight intensity={1.0} />
        <directionalLight position={[5, 10, 5]} intensity={1.0} />
        <OrbitControls enableDamping dampingFactor={0.1} makeDefault />
        <AdaptiveDpr pixelated />
        <Preload all />
        <Suspense fallback={null}>
          <Bounds fit clip margin={1.0}>
            <group ref={contentRef}>
              {common.representation !== "spheres" && cartoon && (
                <>
                  <primitive object={cartoon} />
                  {overlays.bonds && objects.bonds && <primitive object={objects.bonds} />}
                  {overlays.backbone && objects.backbone && <primitive object={objects.backbone} />}
                </>
              )}
              {common.representation === "spheres" && (
                <>
                  {objects.atoms && <primitive object={objects.atoms} />}
                  {objects.bonds && <primitive object={objects.bonds} />}
                  {objects.backbone && <primitive object={objects.backbone} />}
                </>
              )}
            </group>
          </Bounds>
        </Suspense>
      </Canvas>
      {loading && (
        <div style={{ position: "absolute", left: 12, bottom: 12, color: "#ccc", fontFamily: "monospace", fontSize: 12 }}>
          Loading…
        </div>
      )}
      {error && (
        <div style={{ position: "absolute", left: 12, bottom: 12, color: "#f88", fontFamily: "monospace", fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}
