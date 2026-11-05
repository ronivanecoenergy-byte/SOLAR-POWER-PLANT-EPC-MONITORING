import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import XYZ from 'ol/source/XYZ';
import TileGrid from 'ol/tilegrid/TileGrid';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Polygon from 'ol/geom/Polygon';
import MultiLineString from 'ol/geom/MultiLineString';
import MultiPolygon from 'ol/geom/MultiPolygon';
import { Projection } from 'ol/proj';
import { Fill, Stroke, Style, Text } from 'ol/style';
import ScaleLine from 'ol/control/ScaleLine';
import DragBox from 'ol/interaction/DragBox';
import { platformModifierKeyOnly, shiftKeyOnly } from 'ol/events/condition';
import { boundingExtent, buffer, extend, createEmpty, isEmpty } from 'ol/extent';
import type ImageTile from 'ol/ImageTile';
import type { DroneLayer, Subcon, TableState } from '../lib/model';
import { STATUS, statusOf } from '../lib/model';
import { getAccessToken, SUPABASE_ANON_KEY, SUPABASE_URL } from '../lib/store';

export type ColorMode = 'mms_status' | 'mms_subcon' | 'pv_status' | 'pv_subcon' | 'outline';
export interface MapHandle { zoomTo(id: string): void; fitAll(): void; fitIds(ids: Iterable<string>): void; zoomBy(d: number): void }
interface Props {
  tables: TableState[]; byId: globalThis.Map<string, TableState>; subcons: Subcon[]; drone: DroneLayer | null; dataVersion: number;
  mode: ColorMode; showDrone: boolean; showLabels: boolean; showCad: boolean; opacity: number;
  focus: Set<string> | null; selected: string | null; multi: Set<string>; isSubconUser: boolean;
  onSelect: (id: string | null, additive: boolean) => void; onBoxSelect: (ids: string[]) => void;
  scaleTarget: HTMLElement | null; dark: boolean;
}

// second label line must fit inside a 16.8 m table, or OpenLayers hides the whole label
const SHORT: Record<string, string> = { not_started: 'Not installed', ongoing: 'Ongoing', on_hold: 'On hold', ready_for_inspection: 'Ready insp.',
  for_inspection: 'For insp.', for_rectification: 'Rectify', for_approval: 'For appr.', approved: 'Approved', completed: 'Completed' };
const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const MW = 2.384, MH = 1.303, GAP = 0.02;
const hexA = (hex: string, a: number) => {
  const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export const KeyplanMap = forwardRef<MapHandle, Props>(function KeyplanMap(props, ref) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const vecRef = useRef<VectorLayer<VectorSource> | null>(null);
  const tileRef = useRef<TileLayer<XYZ> | null>(null);
  const p = useRef(props); p.current = props;
  const styleCache = useRef(new globalThis.Map<string, Style>());

  // ---------- styling
  function fillFor(t: TableState): { color: string | null; status: string | null; label2: string | null } {
    const { mode, subcons, isSubconUser } = p.current;
    const owned = !isSubconUser || t.mms_work !== null || t.pv_work !== null;
    if (!owned) return { color: null, status: null, label2: null };
    if (mode === 'outline') return { color: null, status: null, label2: null };
    if (mode === 'mms_subcon' || mode === 'pv_subcon') {
      const sid = mode === 'mms_subcon' ? t.mms_subcon : t.pv_subcon;
      const s = sid ? subcons.find((x) => x.id === sid) : null;
      return { color: s ? s.color : null, status: s ? s.code : null, label2: s ? s.code : 'Not specified' };
    }
    const d = mode === 'mms_status' ? 'MMS' : 'PV';
    const st = statusOf(t, d);
    if (!st) return { color: null, status: null, label2: null };
    let label2: string;
    if (d === 'PV') {
      const mods = t.pv_modules ?? 0;
      label2 = st === 'not_started' ? (t.mms_work === 'completed' ? `0/${t.modules_required}` : 'Not installed') : `${mods}/${t.modules_required}`;
    } else label2 = SHORT[st];
    return { color: STATUS[st].color, status: st, label2 };
  }

  function cached(key: string, make: () => Style) {
    const c = styleCache.current; let s = c.get(key);
    if (!s) { s = make(); c.set(key, s); }
    return s;
  }

  function styleFn(f: any, res: number): Style | Style[] {
    const P = p.current; const id = f.getId() as string; const t = P.byId.get(id);
    if (!t) return [];
    const onDrone = P.showDrone && !!P.drone;
    const { color, status, label2 } = fillFor(t);
    const dimmed = !!P.focus && !P.focus.has(id);
    const isSel = P.selected === id; const inMulti = P.multi.has(id);
    const lineCol = onDrone ? 'rgba(255,255,255,0.85)' : (P.dark ? 'rgba(201,211,220,0.75)' : 'rgba(47,58,70,0.75)');
    const alpha = dimmed ? 0.06 : P.opacity;
    const fillCol = color ? hexA(color, alpha) : (onDrone ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0)');
    const strokeCol = dimmed ? (onDrone ? 'rgba(255,255,255,0.22)' : 'rgba(127,140,153,0.35)') : (color && !onDrone ? hexA(color, 0.95) : lineCol);
    const w = res < 0.3 ? 1.25 : 0.8;
    const out: Style[] = [];
    if (P.showCad || color) {
      out.push(cached(`b|${fillCol}|${strokeCol}|${w}|${P.showCad}`, () => new Style({
        fill: new Fill({ color: fillCol }),
        stroke: P.showCad || color ? new Stroke({ color: strokeCol, width: w }) : undefined,
      })));
    }
    // module grid at close zoom (4 rows x 7 columns), installed PV modules filled
    if (res < 0.075 && !dimmed) {
      const [x0, , , y1] = [t.x0, t.y0, t.x1, t.y1];
      const lines: number[][][] = [];
      for (let c = 1; c < t.module_cols; c++) { const x = t.x0 + c * (MW + GAP) - GAP / 2; lines.push([[x, t.y0], [x, t.y1]]); }
      for (let r = 1; r < t.module_rows; r++) { const y = t.y1 - r * (MH + GAP) + GAP / 2; lines.push([[t.x0, y], [t.x1, y]]); }
      out.push(new Style({ geometry: new MultiLineString(lines), stroke: new Stroke({ color: onDrone ? 'rgba(255,255,255,0.55)' : lineCol, width: 0.8 }) }));
      if ((P.mode === 'pv_status' || P.mode === 'pv_subcon') && t.pv_mask) {
        const polys: number[][][][] = [];
        for (let n = 0; n < t.modules_required; n++) if (t.pv_mask & (1 << n)) {
          const r = Math.floor(n / t.module_cols), c = n % t.module_cols;
          const mx0 = x0 + c * (MW + GAP), my1 = y1 - r * (MH + GAP);
          polys.push([[[mx0 + 0.08, my1 - MH + 0.08], [mx0 + MW - 0.08, my1 - MH + 0.08], [mx0 + MW - 0.08, my1 - 0.08], [mx0 + 0.08, my1 - 0.08], [mx0 + 0.08, my1 - MH + 0.08]]]);
        }
        if (polys.length) out.push(new Style({ geometry: new MultiPolygon(polys), fill: new Fill({ color: 'rgba(20,32,60,0.55)' }), stroke: new Stroke({ color: 'rgba(160,190,230,0.9)', width: 1 }) }));
      }
    }
    if (isSel || inMulti) {
      out.push(cached(`sel|${isSel}`, () => new Style({ fill: new Fill({ color: 'rgba(10,91,211,0.30)' }), stroke: new Stroke({ color: isSel ? 'rgba(10,20,40,0.9)' : 'rgba(255,255,255,0.95)', width: isSel ? 6 : 4 }) })));
      out.push(cached(`sel2|${isSel}`, () => new Style({ stroke: new Stroke({ color: isSel ? '#FFC400' : '#0A5BD3', width: isSel ? 3 : 2.5 }) })));
    }
    // labels: Table ID, then x/28 / Not installed / status
    if (P.showLabels && !dimmed && res < 0.36) {
      const px = 16.808 / res;
      const size = Math.max(9, Math.min(17, Math.round(px * 0.105)));
      const text = res < 0.17 && label2 ? `${t.table_code || t.sys_key}\n${label2}` : (t.table_code || t.sys_key);
      const light = onDrone || P.dark;
      out.push(new Style({
        text: new Text({
          text, font: `700 ${size}px "Atkinson Hyperlegible Mono", ui-monospace, monospace`, overflow: false,
          fill: new Fill({ color: light ? '#FFFFFF' : '#132132' }), stroke: new Stroke({ color: light ? 'rgba(10,18,28,0.9)' : 'rgba(255,255,255,0.95)', width: 3 }),
          textAlign: 'center', textBaseline: 'middle',
        }),
      }));
    }
    void status;
    return out;
  }

  // ---------- create the map once
  useEffect(() => {
    const ext = tablesExtent(p.current.tables);
    const world = buffer(p.current.drone ? extend(ext.slice() as any, p.current.drone.meta.extent as any) : ext, 400);
    const proj = new Projection({ code: 'CAD-M', units: 'm', extent: world });
    const vsrc = new VectorSource();
    const vec = new VectorLayer({ source: vsrc, style: styleFn as any, updateWhileInteracting: false, updateWhileAnimating: false, renderBuffer: 60 });
    vecRef.current = vec;
    const map = new Map({
      target: el.current!, layers: [vec], controls: [],
      view: new View({ projection: proj, extent: world, constrainOnlyCenter: true, maxResolution: 6, minResolution: 0.015, smoothResolutionConstraint: true }),
    });
    mapRef.current = map;
    let fitted = false;
    const fitOnce = () => {
      const size = map.getSize();
      if (!fitted && size && size[0] > 50 && size[1] > 50) { map.getView().fit(buffer(ext, 20), { padding: [64, 16, 16, 16] }); fitted = true; }
    };
    map.on('singleclick', (e) => {
      let hit: string | null = null;
      map.forEachFeatureAtPixel(e.pixel, (f) => { hit = f.getId() as string; return true; }, { hitTolerance: 3, layerFilter: (l) => l === vec });
      const oe = e.originalEvent as MouseEvent;
      p.current.onSelect(hit, !!(oe.shiftKey || oe.metaKey || oe.ctrlKey));
    });
    map.on('pointermove', (e) => {
      if (e.dragging) return;
      const hit = map.hasFeatureAtPixel(e.pixel, { hitTolerance: 3, layerFilter: (l) => l === vec });
      (map.getTargetElement() as HTMLElement).style.cursor = hit ? 'pointer' : '';
    });
    const box = new DragBox({ condition: (e) => shiftKeyOnly(e) || platformModifierKeyOnly(e) });
    box.on('boxend', () => {
      const ids: string[] = [];
      vsrc.forEachFeatureIntersectingExtent(box.getGeometry().getExtent(), (f) => { ids.push(f.getId() as string); });
      p.current.onBoxSelect(ids);
    });
    map.addInteraction(box);
    const ro = new ResizeObserver(() => { map.updateSize(); fitOnce(); }); ro.observe(el.current!);
    setTimeout(() => { map.updateSize(); fitOnce(); }, 0);
    return () => { ro.disconnect(); map.setTarget(undefined); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // features
  useEffect(() => {
    const src = vecRef.current?.getSource(); if (!src) return;
    const have = src.getFeatures().length;
    if (have === props.tables.length) { vecRef.current!.changed(); return; }
    src.clear(true);
    src.addFeatures(props.tables.map((t) => {
      const f = new Feature(new Polygon([[[t.x0, t.y0], [t.x1, t.y0], [t.x1, t.y1], [t.x0, t.y1], [t.x0, t.y0]]]));
      f.setId(t.id); return f;
    }));
  }, [props.tables, props.dataVersion]);

  // drone tiles (private bucket: fetched with the user's session)
  useEffect(() => {
    const map = mapRef.current; const d = props.drone; if (!map || !d) return;
    const m = d.meta;
    const grid = new TileGrid({ extent: m.extent, origin: m.origin, resolutions: m.resolutions, tileSize: m.tile_size });
    const src = new XYZ({
      projection: map.getView().getProjection(), tileGrid: grid, wrapX: false, transition: 150,
      tileUrlFunction: (c) => `${c[0]}/${c[1]}/${c[2]}`,
      tileLoadFunction: (tile, key) => {
        const img = (tile as ImageTile).getImage() as HTMLImageElement;
        const token = getAccessToken();
        fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${d.bucket}/${d.prefix}${key}.${m.format || 'webp'}`, {
          headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
        }).then(async (r) => {
          if (!r.ok) { img.src = TRANSPARENT; return; }
          const url = URL.createObjectURL(await r.blob());
          img.onload = () => setTimeout(() => URL.revokeObjectURL(url), 1000);
          img.src = url;
        }).catch(() => { img.src = TRANSPARENT; });
      },
    });
    const layer = new TileLayer({ source: src, visible: props.showDrone, preload: 1 });
    map.getLayers().insertAt(0, layer);
    tileRef.current = layer;
    return () => { map.removeLayer(layer); tileRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.drone?.id]);

  useEffect(() => { tileRef.current?.setVisible(props.showDrone); }, [props.showDrone]);
  useEffect(() => { vecRef.current?.changed(); },
    [props.mode, props.showLabels, props.showCad, props.opacity, props.focus, props.selected, props.multi, props.subcons, props.showDrone, props.dark, props.isSubconUser]);
  useEffect(() => {
    const map = mapRef.current; if (!map || !props.scaleTarget) return;
    const sc = new ScaleLine({ target: props.scaleTarget, units: 'metric', minWidth: 70 });
    map.addControl(sc);
    return () => { map.removeControl(sc); };
  }, [props.scaleTarget]);

  useImperativeHandle(ref, () => ({
    zoomTo(id) {
      const t = p.current.byId.get(id); const map = mapRef.current; if (!t || !map) return;
      const v = map.getView(); const target = Math.min(v.getResolution() || 1, 0.12);
      // on phones the details sheet covers the lower ~60 % of the map: centre the table in the visible part
      const size = map.getSize() || [0, 0]; const sheet = window.innerWidth <= 960 ? size[1] * 0.31 : 0;
      v.animate({ center: [(t.x0 + t.x1) / 2, (t.y0 + t.y1) / 2 - sheet * target], resolution: target, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450 });
    },
    fitAll() { const map = mapRef.current; if (map) map.getView().fit(buffer(tablesExtent(p.current.tables), 30), { duration: 300, padding: [70, 20, 20, 20] }); },
    fitIds(ids) {
      const map = mapRef.current; if (!map) return; const e = createEmpty();
      for (const id of ids) { const t = p.current.byId.get(id); if (t) extend(e, [t.x0, t.y0, t.x1, t.y1]); }
      if (!isEmpty(e)) map.getView().fit(buffer(e, 25), { duration: 300, padding: [80, 30, 30, 30], maxZoom: 99 });
    },
    zoomBy(d) { const v = mapRef.current?.getView(); if (v) v.animate({ resolution: (v.getResolution() || 1) * (d > 0 ? 0.6 : 1.6), duration: 200 }); },
  }));

  return <div ref={el} className="ol" aria-label="Interactive digital keyplan" role="application" />;
});

function tablesExtent(tables: TableState[]) {
  if (!tables.length) return [0, 0, 100, 100];
  return boundingExtent(tables.flatMap((t) => [[t.x0, t.y0], [t.x1, t.y1]]));
}
