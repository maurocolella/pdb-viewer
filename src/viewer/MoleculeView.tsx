import { Suspense, useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, AdaptiveDpr, Preload, Bounds } from "@react-three/drei";
import { Leva, useControls } from "leva";
import type { InstancedMesh, LineSegments, Material } from "three";
import { useMolScene } from "./useMolScene";
import { makeAtomsMesh, makeBondLines, makeBackboneLines } from "pdb-parser";
import type { ParseOptions, MolScene, AtomMeshOptions, BackboneLineOptions } from "pdb-parser";

type SceneBuildOptions = {
  atoms: AtomMeshOptions | false;
  bonds: boolean;
  backbone: BackboneLineOptions | false;
};

function useSceneObjects(scene: MolScene | null, opts: SceneBuildOptions) {
  /* const atomsKey = opts.atoms ? `${opts.atoms.sphereDetail}-${opts.atoms.materialKind}` : "off";
  const bondsKey = opts.bonds ? "on" : "off";
  const backboneKey = opts.backbone ? `${opts.backbone.color ?? "default"}` : "off"; */

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

  const renderOpts = useControls("Render", {
    atoms: true,
    bonds: true,
    backbone: true,
    sphereDetail: { value: 16, min: 4, max: 32, step: 2 },
    materialKind: { value: "standard", options: ["basic", "lambert", "standard"] as const },
    background: { value: "#111111" },
    radiusScale: { value: 0.3, min: 0.05, max: 2.0, step: 0.05 },
  });

  const { scene, error, loading } = useMolScene(sourceUrl, parseOpts as ParseOptions);
  const objects = useSceneObjects(scene, {
    atoms: renderOpts.atoms ? { sphereDetail: renderOpts.sphereDetail, materialKind: renderOpts.materialKind as AtomMeshOptions["materialKind"], radiusScale: renderOpts.radiusScale } : false,
    bonds: renderOpts.bonds,
    backbone: renderOpts.backbone ? {} : false,
  });

  useEffect(() => {
    document.body.style.background = renderOpts.background;
  }, [renderOpts.background]);

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
        <color attach="background" args={[renderOpts.background]} />
        <ambientLight intensity={0.8} />
        <directionalLight position={[5, 10, 5]} intensity={1.0} />
        <OrbitControls enableDamping dampingFactor={0.1} makeDefault />
        <AdaptiveDpr pixelated />
        <Preload all />
        <Suspense fallback={null}>
          <Bounds fit clip observe margin={1.0}>
            {objects.atoms && <primitive object={objects.atoms} />}
            {objects.bonds && <primitive object={objects.bonds} />}
            {objects.backbone && <primitive object={objects.backbone} />}
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
