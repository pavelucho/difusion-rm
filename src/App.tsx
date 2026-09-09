import React, { useEffect, useState, useRef } from 'react';
import { Download, Loader2, Save } from 'lucide-react';
import { es } from './i18n/es';
import { RoiShape, RoiState, rasterizeRoi } from './lib/roi';
import { computeRoiStats, computeContrast, computeLinCCC } from './lib/diffusion/stats';
import { Panel } from './components/Panel';

type AppState = 'IDLE' | 'LOADING' | 'COMPUTING' | 'READY' | 'EXPORTING' | 'ERROR';

export default function App() {
  const [appState, setAppState] = useState<AppState>('IDLE');
  const [progressMsg, setProgressMsg] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  
  const workerRef = useRef<Worker | null>(null);
  const [meta, setMeta] = useState<any>(null);
  
  const [bLow, setBLow] = useState(0);
  const [bHigh, setBHigh] = useState(0);
  const [bTarget, setBTarget] = useState(2000);
  const [threshold, setThreshold] = useState(0);
  const [useMultiB, setUseMultiB] = useState(false);
  const [registrationMode, setRegistrationMode] = useState<'none' | 'translation' | 'rigid'>('translation');
  const [refAdcForWindow, setRefAdcForWindow] = useState(1.0);
  
  // Array of 4 states, one for each panel slot
  const [windowStates, setWindowStates] = useState(
    [0, 1, 2, 3].map(() => ({ center: 0, width: 1, userAdjusted: false }))
  );
  const [volumeDefaults, setVolumeDefaults] = useState<Record<string, { center: number, width: number, isFallback?: boolean, dicomRejected?: boolean, degenerate?: boolean }>>({});
  
  const [currentSlice, setCurrentSlice] = useState(0);
  
  const [results, setResults] = useState<any[]>([]);
  const [vendorAdcData, setVendorAdcData] = useState<any[]>([]);

  const [panelConfigs, setPanelConfigs] = useState<string[]>(['HIGH-B', 'CDWI', 'ADC', 'EADC']);
  const [activeTab, setActiveTab] = useState<'ROI' | 'CONTRAST' | 'VALIDATION' | 'FIDELITY'>('ROI');
  const [fallbackBanner, setFallbackBanner] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<RoiShape | null>(null);
  const [rois, setRois] = useState<RoiState[]>([]);
  const [draftRoi, setDraftRoi] = useState<RoiState | null>(null);

  const [contrastLesionId, setContrastLesionId] = useState<string>('');
  const [contrastRefId, setContrastRefId] = useState<string>('');
  const [contrastBgId, setContrastBgId] = useState<string>('');
  const [contrastRows, setContrastRows] = useState<any[]>([]);

  const [validationPairs, setValidationPairs] = useState<any[]>([]);
  
  // Track active panel to show stats for
  const [activePanelIndex, setActivePanelIndex] = useState(0);
  
  const [syncPanels, setSyncPanels] = useState(true);
  const [syncTransform, setSyncTransform] = useState<{ zoom: number, panX: number, panY: number, sourceId: number, ts: number }>();

  const panelOptions = [
    { id: 'LOW-B', label: 'b baja' },
    { id: 'HIGH-B', label: es.panelAcquiredHigh },
    { id: 'ADC', label: es.panelADC },
    { id: 'EADC', label: es.panelEADC },
    { id: 'CDWI', label: es.panelCDWI },
    { id: 'R2', label: es.panelR2 },
    { id: 'VENDOR-ADC', label: es.panelVendorADC },
    { id: 'DIFF', label: es.panelDifference },
  ];

  useEffect(() => {
    workerRef.current = new Worker(new URL('./lib/diffusion/worker.ts', import.meta.url), { type: 'module' });
    
    workerRef.current.onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === 'PROGRESS') {
        setProgressMsg(payload.step);
        setProgressPct(payload.progress * 100);
      } else if (type === 'LOADED') {
        setMeta(payload);
        setBLow(payload.bLow);
        setBHigh(payload.bHigh);
        setThreshold(payload.threshold);
        
        // Trigger initial compute
        workerRef.current?.postMessage({
          type: 'COMPUTE',
          payload: {
            bLow: payload.bLow,
            bHigh: payload.bHigh,
            bTarget: 2000,
            threshold: payload.threshold,
            useMultiB: false,
            registrationMode: 'translation'
          }
        });
        setAppState('COMPUTING');
      } else if (type === 'COMPUTED') {
        const res = payload.results;
        const compBLow = payload.bLow;
        const compBHigh = payload.bHigh;
        const compThreshold = payload.threshold;

        // El emparejamiento se rehace en cada cálculo según el modo, así que el
        // recuento de cortes descartados cambia con él.
        setMeta((prev: any) => prev && ({
          ...prev,
          sliceCount: res.length,
          discardedCount: payload.discardedCount ?? prev.discardedCount,
          errors: [...(payload.matchErrors ?? []), ...(prev.baseErrors ?? prev.errors ?? [])],
          baseErrors: prev.baseErrors ?? prev.errors ?? [],
        }));
        
        // Compute volume-wide window defaults
        const newDefaults: Record<string, { center: number, width: number, isFallback?: boolean, dicomRejected?: boolean, degenerate?: boolean }> = {
          'ADC': { center: 0.0015, width: 0.003 },
          'VENDOR-ADC': { center: 0.0015, width: 0.003 },
          'EADC': { center: 0.5, width: 1.0 },
          'R2': { center: 0.5, width: 1.0 }
        };
        
        // Helper to compute from array of slices
        const computePercentiles = (getPixels: (i: number) => Float32Array | undefined, maskArr: (i: number) => Uint8Array | undefined, useMask: boolean = true): { center: number, width: number, isFallback?: boolean, dicomRejected?: boolean, degenerate?: boolean } => {
          let values: number[] = [];
          let min = Infinity;
          let max = -Infinity;
          for (let i = 0; i < res.length; i++) {
            const pixels = getPixels(i);
            const mask = maskArr(i);
            if (pixels && mask) {
              for (let j = 0; j < pixels.length; j++) {
                if (pixels[j] < min) min = pixels[j];
                if (pixels[j] > max) max = pixels[j];
                
                if (useMask) {
                  if (mask[j]) values.push(pixels[j]);
                } else {
                  if (pixels[j] > compThreshold) values.push(pixels[j]);
                }
              }
            }
          }
          if (values.length === 0) {
            if (min === Infinity) return { center: 0.5, width: 1 };
            const fallbackWidth = Math.max(1, max - min);
            return { center: (max + min) / 2, width: fallbackWidth, isFallback: true };
          }
          values.sort((a, b) => a - b);
          const p0_5 = values[Math.floor(values.length * 0.005)];
          const p99_5 = values[Math.floor(values.length * 0.995)];
          const width = Math.max(1, p99_5 - p0_5);
          return { center: (p99_5 + p0_5) / 2, width };
        };
        
        function isUsableWindow(w?: { center: number; width: number }): boolean {
          if (!w) return false;
          if (!Number.isFinite(w.center) || !Number.isFinite(w.width)) return false;
          if (w.width <= 1) return false;
          return true;
        }

        // LOW-B default
        const dicomWindows = payload.dicomWindows || {};
        if (isUsableWindow(dicomWindows[compBLow])) {
          newDefaults['LOW-B'] = dicomWindows[compBLow];
        } else {
          newDefaults['LOW-B'] = computePercentiles(i => res[i].registeredSlices[compBLow], i => res[i].maps.mask, false);
          if (!newDefaults['LOW-B'].isFallback) newDefaults['LOW-B'].dicomRejected = true;
        }
        
        // HIGH-B default
        if (isUsableWindow(dicomWindows[compBHigh])) {
          newDefaults['HIGH-B'] = dicomWindows[compBHigh];
        } else {
          newDefaults['HIGH-B'] = computePercentiles(i => res[i].registeredSlices[compBHigh], i => res[i].maps.mask, false);
          if (!newDefaults['HIGH-B'].isFallback) newDefaults['HIGH-B'].dicomRejected = true;
        }
        
        // CDWI default is computed on the fly using refAdcForWindow, but we store the W_ref
        newDefaults['ACQUIRED_HIGH_REF'] = computePercentiles(i => res[i].registeredSlices[compBHigh], i => res[i].maps.mask, true);
        
        setVolumeDefaults(newDefaults);
        
        setResults(res);
        setVendorAdcData(payload.vendorAdcData);
        setAppState('READY');
      } else if (type === 'EXPORTED') {
        const { zipBlob, saturationPct } = payload;
        if (saturationPct > 0.1) {
          alert(es.warnSaturated.replace('{pct}', saturationPct.toFixed(2)));
        }
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'diffusion_maps.zip';
        a.click();
        setAppState('READY');
      } else if (type === 'ERROR') {
        setErrorMsg(payload);
        setAppState('ERROR');
      }
    };
    
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAppState('LOADING');
      setErrorMsg('');
      workerRef.current?.postMessage({ type: 'LOAD_ZIP', payload: { file } });
    }
  };

  const triggerRecompute = (newParams: any) => {
    if (!meta) return;
    setAppState('COMPUTING');
    workerRef.current?.postMessage({
      type: 'COMPUTE',
      payload: { bLow, bHigh, bTarget, threshold, useMultiB, registrationMode, ...newParams }
    });
  };

  return (
    <div className="flex flex-col h-screen bg-[#1A1614] text-[#8E9299] font-sans overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar */}
        <div className="w-80 bg-[#2B221C] p-4 flex flex-col gap-4 overflow-y-auto shrink-0 border-r border-[#3a3028]">
          <h1 className="text-[#F27D26] font-bold text-lg leading-tight">{es.appTitle}</h1>
          
          <label className="cursor-pointer bg-[#F27D26] hover:bg-[#d96a1a] text-[#1A1614] font-semibold py-2 px-4 rounded text-center transition-colors">
            {es.upload}
            <input type="file" accept=".zip" className="hidden" onChange={handleFileUpload} />
          </label>
          <p className="text-xs text-center">{es.uploadHint}</p>
          
          {appState === 'LOADING' || appState === 'COMPUTING' ? (
            <div className="flex flex-col items-center p-4">
              <Loader2 className="animate-spin text-[#F27D26] mb-2" size={32} />
              <div className="text-sm">{progressMsg}</div>
              <div className="w-full bg-[#1A1614] h-2 mt-2 rounded overflow-hidden">
                <div className="bg-[#F27D26] h-full" style={{ width: `${progressPct}%` }}></div>
              </div>
            </div>
          ) : null}

          {errorMsg && (
            <div className="bg-red-900/50 border border-red-500 text-red-200 p-3 rounded text-sm">
              {errorMsg}
            </div>
          )}
          {fallbackBanner && (
            <div className="bg-amber-900/50 border border-amber-500 text-amber-200 p-3 rounded text-sm relative">
              <button 
                className="absolute top-1 right-2 text-amber-200 hover:text-white"
                onClick={() => setFallbackBanner(null)}
              >
                ✕
              </button>
              {fallbackBanner}
            </div>
          )}

          {meta && (
            <div className="flex flex-col gap-3 mt-2">
              <div className="text-xs">
                <div>Cortes usables: {meta.sliceCount}</div>
                {meta.discardedCount > 0 && (
                  <div className="text-amber-500 mt-1">
                    {es.warnSlicesDropped.replace('{n}', meta.discardedCount)}
                  </div>
                )}
                {meta.errors?.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1">
                    {meta.errors.map((aviso: string, i: number) => (
                      <li
                        key={i}
                        className="text-amber-500 border-l-2 border-amber-600/60 pl-2 leading-snug"
                      >
                        {aviso}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold">{es.lowB}</label>
                <select 
                  className="bg-[#1A1614] border border-[#3a3028] p-1 rounded text-sm text-gray-200"
                  value={bLow}
                  onChange={e => {
                    const v = Number(e.target.value);
                    setBLow(v);
                    triggerRecompute({ bLow: v });
                  }}
                >
                  {meta.bValues.map((b: number) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
                {bLow < 150 && (
                  <div className="text-amber-500 text-[10px] mt-1 leading-tight">{es.warnLowB}</div>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold">{es.highB}</label>
                <select 
                  className="bg-[#1A1614] border border-[#3a3028] p-1 rounded text-sm text-gray-200"
                  value={bHigh}
                  onChange={e => {
                    const v = Number(e.target.value);
                    setBHigh(v);
                    triggerRecompute({ bHigh: v });
                  }}
                >
                  {meta.bValues.map((b: number) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>

              {meta.bValues.length >= 3 && (
                <label className="flex items-center gap-2 text-sm mt-2">
                  <input type="checkbox" checked={useMultiB} onChange={e => {
                    setUseMultiB(e.target.checked);
                    triggerRecompute({ useMultiB: e.target.checked });
                  }} />
                  {es.multiBFit}
                </label>
              )}

              <div className="flex flex-col gap-1 mt-1">
                <label className="text-[10px] text-gray-400">{es.regMode}</label>
                <select 
                  className="bg-[#1A1614] border border-[#3a3028] text-xs p-1 rounded text-white"
                  value={registrationMode}
                  onChange={e => {
                    const mode = e.target.value as 'none' | 'translation' | 'rigid';
                    setRegistrationMode(mode);
                    triggerRecompute({ registrationMode: mode });
                  }}
                >
                  <option value="none">{es.regNone}</option>
                  <option value="translation">{es.regTranslation}</option>
                  <option value="rigid">{es.regRotation}</option>
                </select>
                {results[currentSlice]?.transforms && results[currentSlice].transforms[bHigh] && (
                  <div className={`text-[10px] p-1 rounded ${results[currentSlice].transforms[bHigh].fallbackMode ? 'bg-amber-900/30 text-amber-400 border border-amber-900/50' : 'text-gray-500'}`}>
                    {(() => {
                      const t = results[currentSlice].transforms[bHigh];
                      const text = `Corte ${currentSlice + 1}: Δx ${t.dx.toLocaleString('es-PE', {maximumFractionDigits:1})} px · Δy ${t.dy.toLocaleString('es-PE', {maximumFractionDigits:1})} px · θ ${(t.angle * 180 / Math.PI).toLocaleString('es-PE', {maximumFractionDigits:1})}°`;
                      if (t.fallbackMode) {
                        return (
                          <div className="flex flex-col gap-1">
                            <span className="font-semibold">{es.regFallback.replace('{n}', (currentSlice + 1).toString()).replace('{modo}', t.fallbackMode === 'none' ? es.regNone : es.regTranslation)}</span>
                            <span>{text}</span>
                          </div>
                        );
                      }
                      return text;
                    })()}
                  </div>
                )}
              </div>

              <label className="flex items-center gap-2 text-sm mt-1">
                <input type="checkbox" checked={syncPanels} onChange={e => setSyncPanels(e.target.checked)} />
                {es.syncGeometry}
              </label>

              <button 
                onClick={() => setWindowStates(prev => prev.map(w => ({ ...w, userAdjusted: false })))}
                className="text-xs bg-[#1A1614] border border-[#3a3028] hover:bg-[#3a3028] text-gray-300 py-1.5 px-2 rounded mt-1 text-left"
              >
                {es.resetAllWindows}
              </button>

              <div className="flex flex-col gap-1 mt-2">
                <label className="text-xs font-semibold" title={es.refAdcHelp}>{es.refAdcForWindow}</label>
                <div className="flex items-center gap-2">
                  <input 
                    type="range" min={0.5} max={3.0} step={0.1} value={refAdcForWindow}
                    onChange={e => setRefAdcForWindow(Number(e.target.value))}
                    className="flex-1 accent-[#F27D26]"
                  />
                  <span className="text-xs w-8 text-right">{refAdcForWindow.toFixed(1)}</span>
                </div>
              </div>

              <div className="flex flex-col gap-1 mt-2">
                <label className="text-xs font-semibold">{es.noiseThreshold}: {threshold.toFixed(1)}</label>
                <input type="range" min={meta.threshold * 0.5} max={meta.threshold * 5} step={meta.threshold * 0.1}
                  value={threshold}
                  onChange={e => setThreshold(Number(e.target.value))}
                  onMouseUp={() => triggerRecompute({ threshold })}
                  className="accent-[#F27D26]"
                />
              </div>

              {/* TABS FOR ROI / CONTRAST / VALIDATION */}
              <div className="mt-4 pt-4 border-t border-[#3a3028]">
                <div className="flex border-b border-[#3a3028] mb-2">
                  <button 
                    className={`flex-1 py-1 text-xs font-semibold ${activeTab === 'ROI' ? 'text-[#F27D26] border-b-2 border-[#F27D26]' : 'text-gray-500 hover:text-gray-300'}`}
                    onClick={() => setActiveTab('ROI')}
                  >
                    ROI
                  </button>
                  <button 
                    className={`flex-1 py-1 text-xs font-semibold ${activeTab === 'CONTRAST' ? 'text-[#F27D26] border-b-2 border-[#F27D26]' : 'text-gray-500 hover:text-gray-300'}`}
                    onClick={() => setActiveTab('CONTRAST')}
                  >
                    {es.tabContrast}
                  </button>
                  {meta.hasVendorAdc && (
                    <button 
                      className={`flex-1 py-1 text-xs font-semibold ${activeTab === 'VALIDATION' ? 'text-[#F27D26] border-b-2 border-[#F27D26]' : 'text-gray-500 hover:text-gray-300'}`}
                      onClick={() => setActiveTab('VALIDATION')}
                    >
                      {es.tabValidation}
                    </button>
                  )}
                  <button 
                    className={`flex-1 py-1 text-xs font-semibold ${activeTab === 'FIDELITY' ? 'text-[#F27D26] border-b-2 border-[#F27D26]' : 'text-gray-500 hover:text-gray-300'}`}
                    onClick={() => setActiveTab('FIDELITY')}
                  >
                    Fidelidad
                  </button>
                </div>
                
                {activeTab === 'ROI' && (() => {
                  const activePanelConfig = panelConfigs[activePanelIndex];
                  const res = results[currentSlice];
                  let activePixels: Float32Array | undefined;
                  if (res) {
                    if (activePanelConfig === 'ADC') activePixels = res.maps.adc;
                    else if (activePanelConfig === 'EADC') activePixels = res.maps.eadc;
                    else if (activePanelConfig === 'CDWI') activePixels = res.maps.cdwi;
                    else if (activePanelConfig === 'LOW-B') activePixels = res.registeredSlices[bLow];
                    else if (activePanelConfig === 'HIGH-B') activePixels = res.registeredSlices[bHigh];
                    else if (activePanelConfig === 'R2') activePixels = res.maps.r2;
                    else if (activePanelConfig === 'VENDOR-ADC') activePixels = vendorAdcData[currentSlice];
                    else if (activePanelConfig === 'DIFF' && res.maps.cdwi && res.registeredSlices[bHigh]) {
                      activePixels = new Float32Array(res.maps.cdwi.length);
                      for (let i = 0; i < activePixels.length; i++) {
                        if (res.maps.mask[i] === 1) {
                          activePixels[i] = res.maps.cdwi[i] - res.registeredSlices[bHigh][i];
                        }
                      }
                    }
                  }
                  
                  const roiStatsList = rois.filter(r => r.sliceIndex === currentSlice).map(roi => {
                    if (!activePixels || !meta) return { roi, stats: null };
                    const roiMask = rasterizeRoi(roi, meta.columns, meta.rows);
                    return { roi, stats: computeRoiStats({ pixels: activePixels, validityMask: res.maps.mask, roiMask }) };
                  });

                  return (
                    <div className="flex flex-col gap-2">
                      <div className="flex gap-1 justify-between mb-2">
                        <button className={`flex-1 py-1 text-xs rounded border ${activeTool === 'circle' ? 'bg-[#F27D26] border-[#F27D26] text-black font-semibold' : 'border-[#3a3028] text-gray-300 hover:bg-[#3a3028]'}`}
                          onClick={() => setActiveTool(activeTool === 'circle' ? null : 'circle')}
                        >
                          {es.roiCircle}
                        </button>
                        <button className={`flex-1 py-1 text-xs rounded border ${activeTool === 'ellipse' ? 'bg-[#F27D26] border-[#F27D26] text-black font-semibold' : 'border-[#3a3028] text-gray-300 hover:bg-[#3a3028]'}`}
                          onClick={() => setActiveTool(activeTool === 'ellipse' ? null : 'ellipse')}
                        >
                          {es.roiEllipse}
                        </button>
                        <button className={`flex-1 py-1 text-xs rounded border ${activeTool === 'polygon' ? 'bg-[#F27D26] border-[#F27D26] text-black font-semibold' : 'border-[#3a3028] text-gray-300 hover:bg-[#3a3028]'}`}
                          onClick={() => setActiveTool(activeTool === 'polygon' ? null : 'polygon')}
                        >
                          {es.roiPolygon}
                        </button>
                      </div>
                      {rois.length === 0 ? (
                        <div className="text-[10px] text-gray-500 text-center py-2">{es.roiEmpty}</div>
                      ) : (
                        <div className="flex flex-col gap-1 max-h-48 overflow-y-auto pr-1">
                          {rois.map((roi) => (
                            <div key={roi.id} className="flex flex-col bg-[#1A1614] border border-[#3a3028] rounded p-2 text-xs">
                              <div className="flex items-center gap-2 mb-1">
                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: roi.color }} />
                                <input 
                                  className="flex-1 bg-transparent text-white border-b border-gray-700 outline-none focus:border-[#F27D26]"
                                  value={roi.label}
                                  onChange={e => {
                                    setRois(rois.map(r => r.id === roi.id ? { ...r, label: e.target.value } : r));
                                  }}
                                />
                                <button 
                                  className="text-gray-500 hover:text-red-400"
                                  onClick={() => setRois(rois.filter(r => r.id !== roi.id))}
                                  title={es.roiDelete}
                                >
                                  ✕
                                </button>
                              </div>
                              <div className="flex gap-1">
                                {['Lesión', 'Referencia', 'Fondo'].map(lbl => (
                                  <button 
                                    key={lbl} 
                                    className="text-[9px] bg-[#2B221C] border border-[#3a3028] rounded px-1 hover:text-white"
                                    onClick={() => setRois(rois.map(r => r.id === roi.id ? { ...r, label: lbl } : r))}
                                  >
                                    {lbl}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      
                      {roiStatsList.length === 0 ? (
                        <div className="text-sm text-gray-500 text-center py-4">{es.roiEmpty}</div>
                      ) : (
                        <div className="mt-2 overflow-x-auto">
                          <div className="text-[10px] text-gray-400 mb-1">Estadísticas en: {panelOptions.find(o => o.id === activePanelConfig)?.label}</div>
                          <table className="w-full text-[9px] text-left border-collapse whitespace-nowrap">
                            <thead>
                              <tr className="border-b border-[#3a3028] text-gray-500">
                                <th className="font-normal pr-2">Etiqueta</th>
                                <th className="font-normal pr-2">Vóxeles</th>
                                <th className="font-normal pr-2">Enmasc.</th>
                                {activePanelConfig === 'ADC' || activePanelConfig === 'VENDOR-ADC' ? (
                                  <>
                                    <th className="font-normal pr-2">Media (10⁻³ mm²/s)</th>
                                    <th className="font-normal pr-2">Media (10⁻⁶ mm²/s)</th>
                                  </>
                                ) : (
                                  <th className="font-normal pr-2">Media</th>
                                )}
                                <th className="font-normal pr-2">DE</th>
                                <th className="font-normal pr-2">Mediana</th>
                                <th className="font-normal pr-2">Mín</th>
                                <th className="font-normal pr-2">Máx</th>
                                <th className="font-normal pr-2">P10</th>
                                <th className="font-normal">P90</th>
                              </tr>
                            </thead>
                            <tbody>
                              {roiStatsList.map(({ roi, stats }) => {
                                if (!stats || stats.n === 0) return (
                                  <tr key={roi.id} className="border-b border-[#3a3028]/50">
                                    <td className="py-1 pr-2 text-gray-300 flex items-center gap-1">
                                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: roi.color }} />
                                      {roi.label}
                                    </td>
                                    <td colSpan={10} className="text-gray-600">No hay vóxeles válidos</td>
                                  </tr>
                                );
                                
                                const isADC = activePanelConfig === 'ADC' || activePanelConfig === 'VENDOR-ADC';
                                
                                return (
                                  <tr key={roi.id} className="border-b border-[#3a3028]/50 text-gray-300">
                                    <td className="py-1 pr-2 flex items-center gap-1">
                                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: roi.color }} />
                                      {roi.label}
                                    </td>
                                    <td className="pr-2">{stats.n}</td>
                                    <td className="pr-2 text-gray-500">{stats.masked} ({((stats.masked / (stats.n + stats.masked)) * 100).toFixed(0)}%)</td>
                                    {isADC ? (
                                      <>
                                        <td className="pr-2 text-[#F27D26]">{(stats.mean * 1e3).toLocaleString('es-PE', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</td>
                                        <td className="pr-2">{(stats.mean * 1e6).toLocaleString('es-PE', { maximumFractionDigits: 0 })}</td>
                                      </>
                                    ) : (
                                      <td className="pr-2 text-[#F27D26]">{stats.mean.toFixed(3)}</td>
                                    )}
                                    <td className="pr-2">{isADC ? (stats.std * 1e6).toFixed(0) : stats.std.toFixed(3)}</td>
                                    <td className="pr-2">{isADC ? (stats.median * 1e6).toFixed(0) : stats.median.toFixed(3)}</td>
                                    <td className="pr-2">{isADC ? (stats.min * 1e6).toFixed(0) : stats.min.toFixed(3)}</td>
                                    <td className="pr-2">{isADC ? (stats.max * 1e6).toFixed(0) : stats.max.toFixed(3)}</td>
                                    <td className="pr-2">{isADC ? (stats.p10 * 1e6).toFixed(0) : stats.p10.toFixed(3)}</td>
                                    <td>{isADC ? (stats.p90 * 1e6).toFixed(0) : stats.p90.toFixed(3)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })()}
                
                {activeTab === 'CONTRAST' && (() => {
                  const lesionRoi = rois.find(r => r.id === contrastLesionId);
                  const refRoi = rois.find(r => r.id === contrastRefId);
                  const bgRoi = rois.find(r => r.id === contrastBgId);
                  
                  let liveRows: any[] = [];
                  if (lesionRoi && refRoi && bgRoi && results[currentSlice] && meta) {
                    const res = results[currentSlice];
                    const lesionMask = rasterizeRoi(lesionRoi, meta.columns, meta.rows);
                    const refMask = rasterizeRoi(refRoi, meta.columns, meta.rows);
                    const bgMask = rasterizeRoi(bgRoi, meta.columns, meta.rows);
                    
                    const computeForMap = (name: string, pixels: Float32Array) => {
                      const stL = computeRoiStats({ pixels, validityMask: res.maps.mask, roiMask: lesionMask });
                      const stR = computeRoiStats({ pixels, validityMask: res.maps.mask, roiMask: refMask });
                      const stB = computeRoiStats({ pixels, validityMask: res.maps.mask, roiMask: bgMask });
                      if (stL.n === 0 || stR.n === 0 || stB.n === 0 || stB.std === 0 || stR.mean === 0) return null;
                      const { cr, cnr } = computeContrast(stL.mean, stR.mean, stB.std);
                      return { name, cr, cnr, stL, stR, stB };
                    };
                    
                    liveRows = [
                      computeForMap(`DWI (b=${bHigh})`, res.registeredSlices[bHigh]),
                      ...contrastRows.map(r => computeForMap(r.name, r.pixels)),
                      computeForMap(`cDWI (b=${bTarget})`, res.maps.cdwi),
                      computeForMap('ADC', res.maps.adc),
                      computeForMap('eADC', res.maps.eadc)
                    ].filter(Boolean);
                  }

                  const allRois = rois.filter(r => r.sliceIndex === currentSlice);

                  return (
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-gray-400">{es.contrastLesion}</label>
                        <select className="bg-[#1A1614] border border-[#3a3028] text-xs p-1 rounded text-white" value={contrastLesionId} onChange={e => setContrastLesionId(e.target.value)}>
                          <option value="">-- Seleccionar --</option>
                          {allRois.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                        </select>
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-gray-400">{es.contrastReference}</label>
                        <select className="bg-[#1A1614] border border-[#3a3028] text-xs p-1 rounded text-white" value={contrastRefId} onChange={e => setContrastRefId(e.target.value)}>
                          <option value="">-- Seleccionar --</option>
                          {allRois.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                        </select>
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-gray-400">{es.contrastBackground}</label>
                        <select className="bg-[#1A1614] border border-[#3a3028] text-xs p-1 rounded text-white" value={contrastBgId} onChange={e => setContrastBgId(e.target.value)}>
                          <option value="">-- Seleccionar --</option>
                          {allRois.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                        </select>
                      </div>

                      {!lesionRoi || !refRoi || !bgRoi ? (
                        <div className="text-[10px] text-gray-500 mt-2">{es.contrastIncomplete}</div>
                      ) : (
                        <div className="mt-2">
                          <button 
                            className="w-full bg-[#3a3028] hover:bg-[#4a3f35] text-xs py-1 rounded mb-2 text-gray-200"
                            onClick={() => {
                              const res = results[currentSlice];
                              if (res) {
                                setContrastRows([...contrastRows, { name: `cDWI (b=${bTarget})`, pixels: res.maps.cdwi }]);
                              }
                            }}
                          >
                            {es.contrastAddRow}
                          </button>
                          
                          <table className="w-full text-[10px] text-left border-collapse">
                            <thead>
                              <tr className="border-b border-[#3a3028] text-gray-500">
                                <th className="font-normal pb-1">Mapa</th>
                                <th className="font-normal pb-1">CR</th>
                                <th className="font-normal pb-1">CNR</th>
                              </tr>
                            </thead>
                            <tbody>
                              {liveRows.map((row, idx) => {
                                const isMaxCnr = row.cnr === Math.max(...liveRows.map(r => r.cnr));
                                return (
                                  <tr key={idx} className={`border-b border-[#3a3028]/50 ${isMaxCnr ? 'text-[#F27D26] font-semibold' : 'text-gray-300'}`}>
                                    <td className="py-1">{row.name}</td>
                                    <td>{row.cr.toFixed(3)}</td>
                                    <td>{row.cnr.toFixed(2)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>

                          <button 
                            className="mt-2 text-[10px] text-blue-400 hover:text-blue-300"
                            onClick={() => {
                              let csv = `Estudio:,${meta?.patientName || 'Anon'},Corte:,${currentSlice+1},Fecha:,${new Date().toISOString()}\n`;
                              csv += `b_low:,${bLow},b_high:,${bHigh}\n\n`;
                              csv += `Mapa,CR,CNR\n`;
                              liveRows.forEach(r => {
                                csv += `${r.name},${r.cr.toFixed(3)},${r.cnr.toFixed(3)}\n`;
                              });
                              const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = 'contraste.csv';
                              a.click();
                            }}
                          >
                            {es.exportCsv}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })()}
                
                {activeTab === 'VALIDATION' && (() => {
                  const allRois = rois.filter(r => r.sliceIndex === currentSlice);
                  const [selectedRoiId, setSelectedRoiId] = useState<string>('');

                  let cccResult = null;
                  if (validationPairs.length > 1) {
                    const calc = validationPairs.map(p => p.calcMean);
                    const vend = validationPairs.map(p => p.vendMean);
                    cccResult = computeLinCCC(vend, calc); // x=vendor, y=calc
                  }

                  const handleAddPair = () => {
                    const roi = rois.find(r => r.id === selectedRoiId);
                    const res = results[currentSlice];
                    if (!roi || !res || !meta || !meta.hasVendorAdc) return;
                    
                    const roiMask = rasterizeRoi(roi, meta.columns, meta.rows);
                    const calcStats = computeRoiStats({ pixels: res.maps.adc, validityMask: res.maps.mask, roiMask });
                    const vendStats = computeRoiStats({ pixels: vendorAdcData[currentSlice], validityMask: res.maps.mask, roiMask });
                    
                    if (calcStats.n > 0 && vendStats.n > 0) {
                      setValidationPairs([...validationPairs, {
                        id: Math.random().toString(36).substring(2, 9),
                        studyId: meta.patientName || 'Anon',
                        slice: currentSlice + 1,
                        label: roi.label,
                        n: calcStats.n,
                        calcMean: calcStats.mean,
                        calcStd: calcStats.std,
                        vendMean: vendStats.mean,
                        vendStd: vendStats.std,
                        diff: calcStats.mean - vendStats.mean,
                        diffPct: ((calcStats.mean - vendStats.mean) / Math.abs(vendStats.mean)) * 100
                      }]);
                    }
                  };

                  return (
                    <div className="flex flex-col gap-2">
                      <div className="flex gap-2 items-end">
                        <div className="flex flex-col gap-1 flex-1">
                          <label className="text-[10px] text-gray-400">ROI para validar</label>
                          <select className="bg-[#1A1614] border border-[#3a3028] text-xs p-1 rounded text-white" value={selectedRoiId} onChange={e => setSelectedRoiId(e.target.value)}>
                            <option value="">-- Seleccionar --</option>
                            {allRois.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                          </select>
                        </div>
                        <button 
                          className="bg-[#3a3028] hover:bg-[#4a3f35] text-xs py-1 px-2 rounded text-gray-200 disabled:opacity-50"
                          onClick={handleAddPair}
                          disabled={!selectedRoiId}
                        >
                          {es.validationAddPair}
                        </button>
                      </div>
                      
                      {validationPairs.length === 0 ? (
                        <div className="text-[10px] text-gray-500 mt-2">{es.validationEmpty}</div>
                      ) : (
                        <div className="mt-2 flex flex-col gap-2">
                          <div className="flex justify-between items-center">
                            <span className="text-[10px] text-gray-400">{es.validationPairs} (n={validationPairs.length})</span>
                            <div className="flex gap-2">
                              <button className="text-[9px] text-red-400 hover:text-red-300" onClick={() => setValidationPairs([])}>
                                {es.validationClear}
                              </button>
                              <button className="text-[9px] text-blue-400 hover:text-blue-300" onClick={() => {
                                let csv = `Estudio,Corte,Etiqueta,Voxeles,ADC_Calc_Media,ADC_Calc_DE,ADC_Eq_Media,ADC_Eq_DE,Diferencia,Dif_Pct\n`;
                                validationPairs.forEach(p => {
                                  csv += `${p.studyId},${p.slice},${p.label},${p.n},${p.calcMean.toFixed(6)},${p.calcStd.toFixed(6)},${p.vendMean.toFixed(6)},${p.vendStd.toFixed(6)},${p.diff.toFixed(6)},${p.diffPct.toFixed(2)}\n`;
                                });
                                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = 'validacion_adc.csv';
                                a.click();
                              }}>
                                {es.exportCsv}
                              </button>
                            </div>
                          </div>
                          
                          <div className="max-h-32 overflow-y-auto">
                            <table className="w-full text-[9px] text-left border-collapse whitespace-nowrap">
                              <thead>
                                <tr className="border-b border-[#3a3028] text-gray-500">
                                  <th className="font-normal pr-2">Corte</th>
                                  <th className="font-normal pr-2">Etiqueta</th>
                                  <th className="font-normal pr-2">Calc (10⁻⁶)</th>
                                  <th className="font-normal pr-2">Eq (10⁻⁶)</th>
                                  <th className="font-normal pr-2">Dif %</th>
                                </tr>
                              </thead>
                              <tbody>
                                {validationPairs.map((p) => (
                                  <tr key={p.id} className="border-b border-[#3a3028]/50 text-gray-300">
                                    <td className="py-1 pr-2">{p.slice}</td>
                                    <td className="pr-2">{p.label}</td>
                                    <td className="pr-2">{(p.calcMean * 1e6).toFixed(0)}</td>
                                    <td className="pr-2">{(p.vendMean * 1e6).toFixed(0)}</td>
                                    <td className="pr-2">{p.diffPct > 0 ? '+' : ''}{p.diffPct.toFixed(1)}%</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>

                          {cccResult && validationPairs.length > 1 && (() => {
                            // SVG dimensions
                            const w = 260;
                            const h = 120;
                            const margin = { top: 10, right: 10, bottom: 20, left: 30 };
                            const innerW = w - margin.left - margin.right;
                            const innerH = h - margin.top - margin.bottom;

                            // Scatter Plot Scale
                            const allVals = validationPairs.flatMap(p => [p.calcMean * 1e6, p.vendMean * 1e6]);
                            const minVal = Math.min(...allVals) * 0.9;
                            const maxVal = Math.max(...allVals) * 1.1;
                            const scaleMap = (v: number) => margin.left + ((v - minVal) / (maxVal - minVal)) * innerW;
                            const scaleMapY = (v: number) => margin.top + innerH - ((v - minVal) / (maxVal - minVal)) * innerH;

                            // Bland-Altman Scale
                            const diffs = validationPairs.map(p => p.diff * 1e6);
                            const means = validationPairs.map(p => ((p.calcMean + p.vendMean) / 2) * 1e6);
                            const meanMin = Math.min(...means) * 0.9;
                            const meanMax = Math.max(...means) * 1.1;
                            const diffMaxAbs = Math.max(...diffs.map(Math.abs), Math.abs(cccResult.bias * 1e6) + cccResult.sd * 1e6 * 2.5);
                            const scaleBAX = (v: number) => margin.left + ((v - meanMin) / (meanMax - meanMin)) * innerW;
                            const scaleBAY = (v: number) => margin.top + innerH / 2 - (v / diffMaxAbs) * (innerH / 2);

                            const bias = cccResult.bias * 1e6;
                            const loa = 1.96 * cccResult.sd * 1e6;

                            return (
                              <div className="flex flex-col gap-2 mt-2">
                                <div className="text-[9px] bg-[#1A1614] p-2 border border-[#3a3028] rounded flex flex-col gap-1">
                                  <div className="flex justify-between">
                                    <span className="text-gray-400">{es.cccLabel}:</span>
                                    <span className="text-[#F27D26] font-semibold">{cccResult.ccc.toFixed(3)}</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-gray-400">{es.biasLabel}:</span>
                                    <span className="text-gray-200">{bias.toFixed(0)} (10⁻⁶ mm²/s)</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-gray-400">{es.loaLabel}:</span>
                                    <span className="text-gray-200">±{loa.toFixed(0)} (10⁻⁶ mm²/s)</span>
                                  </div>
                                </div>

                                <div className="flex flex-col gap-1">
                                  <div className="text-[10px] text-gray-400 text-center">{es.scatterTitle}</div>
                                  <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} className="bg-[#1A1614] border border-[#3a3028] rounded">
                                    {/* Identity line */}
                                    <line x1={scaleMap(minVal)} y1={scaleMapY(minVal)} x2={scaleMap(maxVal)} y2={scaleMapY(maxVal)} stroke="#4a3f35" strokeDasharray="2" />
                                    {/* Points */}
                                    {validationPairs.map(p => (
                                      <circle key={p.id} cx={scaleMap(p.vendMean * 1e6)} cy={scaleMapY(p.calcMean * 1e6)} r={2} fill="#F27D26" />
                                    ))}
                                    {/* Axes */}
                                    <line x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + innerH} stroke="#3a3028" />
                                    <line x1={margin.left} y1={margin.top + innerH} x2={margin.left + innerW} y2={margin.top + innerH} stroke="#3a3028" />
                                    <text x={margin.left - 5} y={margin.top + 5} fill="#666" fontSize="8" textAnchor="end">Calc</text>
                                    <text x={w - 5} y={margin.top + innerH - 5} fill="#666" fontSize="8" textAnchor="end">Eq</text>
                                  </svg>
                                </div>

                                <div className="flex flex-col gap-1">
                                  <div className="text-[10px] text-gray-400 text-center">{es.blandAltmanTitle}</div>
                                  <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} className="bg-[#1A1614] border border-[#3a3028] rounded">
                                    {/* Zero line */}
                                    <line x1={margin.left} y1={scaleBAY(0)} x2={margin.left + innerW} y2={scaleBAY(0)} stroke="#4a3f35" />
                                    {/* Bias line */}
                                    <line x1={margin.left} y1={scaleBAY(bias)} x2={margin.left + innerW} y2={scaleBAY(bias)} stroke="#F27D26" strokeWidth={0.5} />
                                    {/* LoA lines */}
                                    <line x1={margin.left} y1={scaleBAY(bias + loa)} x2={margin.left + innerW} y2={scaleBAY(bias + loa)} stroke="#F27D26" strokeDasharray="2" strokeWidth={0.5} />
                                    <line x1={margin.left} y1={scaleBAY(bias - loa)} x2={margin.left + innerW} y2={scaleBAY(bias - loa)} stroke="#F27D26" strokeDasharray="2" strokeWidth={0.5} />
                                    {/* Points */}
                                    {validationPairs.map(p => (
                                      <circle key={p.id} cx={scaleBAX(((p.calcMean + p.vendMean) / 2) * 1e6)} cy={scaleBAY(p.diff * 1e6)} r={2} fill="#F27D26" />
                                    ))}
                                    {/* Axes */}
                                    <line x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + innerH} stroke="#3a3028" />
                                    <line x1={margin.left} y1={margin.top + innerH} x2={margin.left + innerW} y2={margin.top + innerH} stroke="#3a3028" />
                                  </svg>
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  );
                })()}
                
                {activeTab === 'FIDELITY' && (() => {
                  const res = results[currentSlice];
                  let fidelityStatus: 'pending' | 'good' | 'fair' | 'poor' | 'error' = 'pending';
                  let mae = 0;
                  let corr = 0;
                  
                  const canCheck = meta && res && res.maps.cdwi && res.registeredSlices[bHigh];
                  
                  if (canCheck && bTarget === bHigh) {
                    let sumError = 0;
                    let count = 0;
                    let sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0, sumXY = 0;
                    const cdwi = res.maps.cdwi;
                    const acquired = res.registeredSlices[bHigh];
                    
                    for (let i = 0; i < cdwi.length; i++) {
                      if (res.maps.mask[i] === 1) {
                        const x = cdwi[i];
                        const y = acquired[i];
                        const diff = Math.abs(x - y);
                        sumError += diff;
                        sumX += x;
                        sumY += y;
                        sumX2 += x * x;
                        sumY2 += y * y;
                        sumXY += x * y;
                        count++;
                      }
                    }
                    
                    if (count > 0) {
                      mae = sumError / count;
                      const meanX = sumX / count;
                      const meanY = sumY / count;
                      const num = sumXY - count * meanX * meanY;
                      const den = Math.sqrt((sumX2 - count * meanX * meanX) * (sumY2 - count * meanY * meanY));
                      corr = den === 0 ? 0 : num / den;
                      
                      if (mae < 10) fidelityStatus = 'good';
                      else if (mae < 25) fidelityStatus = 'fair';
                      else fidelityStatus = 'poor';
                    } else {
                      fidelityStatus = 'error';
                    }
                  }
                  
                  return (
                    <div className="flex flex-col gap-3">
                      <p className="text-xs text-gray-400 leading-relaxed">
                        {es.fidelityHelp}
                      </p>
                      <button 
                        className="bg-[#F27D26] hover:bg-[#d66b1e] text-white text-xs font-semibold py-2 px-3 rounded w-full transition-colors"
                        onClick={() => {
                          if (bTarget !== bHigh) {
                            setBTarget(bHigh);
                            triggerRecompute({ bTarget: bHigh });
                          }
                        }}
                      >
                        {bTarget === bHigh && appState === 'COMPUTING' ? es.fidelityRunning : es.fidelityCheck}
                      </button>
                      
                      {bTarget === bHigh && appState !== 'COMPUTING' && fidelityStatus !== 'pending' && (
                        <div className="flex flex-col gap-2 p-3 bg-black/40 rounded border border-[#3a3028]">
                          <div className={`text-sm font-semibold flex items-center gap-2 ${
                            fidelityStatus === 'good' ? 'text-emerald-500' :
                            fidelityStatus === 'fair' ? 'text-amber-500' :
                            'text-red-500'
                          }`}>
                            <div className={`w-2 h-2 rounded-full ${
                              fidelityStatus === 'good' ? 'bg-emerald-500' :
                              fidelityStatus === 'fair' ? 'bg-amber-500' :
                              'bg-red-500'
                            }`} />
                            {fidelityStatus === 'good' ? es.fidelityGood :
                             fidelityStatus === 'fair' ? es.fidelityFair :
                             es.fidelityPoor}
                          </div>
                          
                          <div className="grid grid-cols-2 gap-2 mt-1">
                            <div className="bg-[#1A1614] p-2 rounded flex flex-col">
                              <span className="text-[10px] text-gray-500">{es.fidelityError}</span>
                              <span className="text-sm text-gray-200">{mae.toFixed(2)}</span>
                            </div>
                            <div className="bg-[#1A1614] p-2 rounded flex flex-col">
                              <span className="text-[10px] text-gray-500">{es.fidelityCorr}</span>
                              <span className="text-sm text-gray-200">{corr.toFixed(4)}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              <div className="mt-4 pt-4 border-t border-[#3a3028] flex flex-col gap-2">
                <button
                  className="bg-[#3a3028] hover:bg-[#4a3f35] text-gray-200 text-xs py-2 px-3 rounded flex items-center justify-center gap-2"
                  onClick={() => {
                    setAppState('EXPORTING');
                    workerRef.current?.postMessage({
                      type: 'EXPORT_DICOM',
                      payload: { mapsData: results }
                    });
                  }}
                  disabled={appState !== 'READY'}
                >
                  <Download size={14} />
                  {es.exportMaps}
                </button>
                <button
                  className="bg-[#3a3028] hover:bg-[#4a3f35] text-gray-200 text-xs py-2 px-3 rounded flex items-center justify-center gap-2"
                  onClick={() => {
                    const log = {
                      timestamp: new Date().toISOString(),
                      toolVersion: "1.0",
                      detectedBValues: meta.bValues,
                      selectedBLow: bLow,
                      selectedBHigh: bHigh,
                      targetB: bTarget,
                      multiB: useMultiB,
                      registration: registrationMode,
                      noiseThreshold: threshold,
                      sliceCount: meta.sliceCount,
                      discardedCount: meta.discardedCount,
                      transforms: results.map(r => r.transforms),
                      windows: [0, 1, 2, 3].map(i => {
                        const type = panelConfigs[i];
                        const userAdj = windowStates[i].userAdjusted;
                        let center = userAdj ? windowStates[i].center : (volumeDefaults[type]?.center || 0);
                        let width = userAdj ? windowStates[i].width : (volumeDefaults[type]?.width || 1);
                        if (!userAdj && type === 'CDWI' && volumeDefaults['ACQUIRED_HIGH_REF']) {
                           width = Math.max(1, volumeDefaults['ACQUIRED_HIGH_REF'].width * Math.exp(-(bTarget - bHigh) * refAdcForWindow * 1e-3));
                           center = width / 2;
                        }
                        return {
                          mapType: type,
                          windowCenter: center,
                          windowWidth: width,
                          userAdjusted: userAdj,
                          refAdc: type === 'CDWI' ? refAdcForWindow : undefined,
                          degenerateWindow: (type === 'CDWI' ? volumeDefaults['ACQUIRED_HIGH_REF']?.degenerate : volumeDefaults[type]?.degenerate) || false,
                          dicomRejected: volumeDefaults[type]?.dicomRejected || false
                        };
                      }),
                      volumeDefaults: {
                        'LOW-B': volumeDefaults['LOW-B'],
                        'HIGH-B': volumeDefaults['HIGH-B'],
                        'ACQUIRED_HIGH_REF': volumeDefaults['ACQUIRED_HIGH_REF']
                      }
                    };
                    const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'processing_log.json';
                    a.click();
                  }}
                >
                  <Save size={14} />
                  {es.exportLog}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Main Area */}
        <div className="flex-1 bg-black relative flex flex-col">
          {appState === 'READY' && results.length > 0 && (
            <div className="flex-1 grid grid-cols-2 grid-rows-2 p-1 gap-1 min-h-0">
              {panelConfigs.map((type, i) => {
                const res = results[currentSlice];
                let pixels: Float32Array | undefined;
                let colormap: 'gray' | 'hot' = 'gray';
                
                if (type === 'ADC') {
                  pixels = res.maps.adc;
                  colormap = 'gray'; // Add toggle if needed
                } else if (type === 'EADC') {
                  pixels = res.maps.eadc;
                } else if (type === 'CDWI') {
                  pixels = res.maps.cdwi;
                } else if (type === 'LOW-B') {
                  pixels = res.registeredSlices[bLow];
                } else if (type === 'HIGH-B') {
                  pixels = res.registeredSlices[bHigh];
                } else if (type === 'R2') {
                  pixels = res.maps.r2;
                } else if (type === 'VENDOR-ADC') {
                  pixels = vendorAdcData[currentSlice];
                } else if (type === 'DIFF') {
                  if (res.maps.cdwi && res.registeredSlices[bHigh]) {
                    pixels = new Float32Array(res.maps.cdwi.length);
                    for (let i = 0; i < pixels.length; i++) {
                      if (res.maps.mask[i] === 1) {
                        pixels[i] = res.maps.cdwi[i] - res.registeredSlices[bHigh][i];
                      }
                    }
                  }
                }

                return (
                  <div key={i} className="flex flex-col relative h-full">
                    <select 
                      className="absolute top-1 right-1 z-20 bg-black/80 text-[#F27D26] text-xs border border-[#3a3028] rounded px-1"
                      value={type}
                      onChange={(e) => {
                        const newConfigs = [...panelConfigs];
                        newConfigs[i] = e.target.value;
                        setPanelConfigs(newConfigs);
                        setWindowStates(prev => {
                          const next = [...prev];
                          next[i] = { ...next[i], userAdjusted: false };
                          return next;
                        });
                      }}
                    >
                      {panelOptions.map(opt => (
                        <option key={opt.id} value={opt.id}>{opt.label}</option>
                      ))}
                    </select>
                    <Panel
                      id={i}
                      title={panelOptions.find(o => o.id === type)?.label || type}
                      mapType={type}
                      pixels={pixels}
                      mask={res.maps.mask}
                      width={meta?.columns || 256}
                      height={meta?.rows || 256}
                      colormap={colormap}
                      onWheel={(delta) => {
                        let next = currentSlice + delta;
                        if (next < 0) next = 0;
                        if (meta && next >= meta.sliceCount) next = meta.sliceCount - 1;
                        setCurrentSlice(next);
                      }}
                      windowCenter={
                        windowStates[i].userAdjusted 
                          ? windowStates[i].center 
                          : (type === 'CDWI' && volumeDefaults['ACQUIRED_HIGH_REF']
                              ? Math.max(1, volumeDefaults['ACQUIRED_HIGH_REF'].width * Math.exp(-(bTarget - bHigh) * refAdcForWindow * 1e-3)) / 2
                              : volumeDefaults[type]?.center || 0)
                      }
                      windowWidth={
                        windowStates[i].userAdjusted 
                          ? windowStates[i].width 
                          : (type === 'CDWI' && volumeDefaults['ACQUIRED_HIGH_REF']
                              ? Math.max(1, volumeDefaults['ACQUIRED_HIGH_REF'].width * Math.exp(-(bTarget - bHigh) * refAdcForWindow * 1e-3))
                              : volumeDefaults[type]?.width || 1)
                      }
                      userAdjusted={windowStates[i].userAdjusted}
                      onWindowChange={(center, width, userAdjusted) => {
                        setWindowStates(prev => {
                          const next = [...prev];
                          next[i] = { center, width, userAdjusted };
                          return next;
                        });
                      }}
                      onWlDrag={(dx, dy) => {
                        if (syncPanels) {
                          setWindowStates(prev => {
                            const next = [...prev];
                            // Apply to all panels of same mapType
                            for (let p = 0; p < 4; p++) {
                              if (panelConfigs[p] === type && p !== i) {
                                // Calculate center/width on the fly based on what it is right now
                                const currentWidth = next[p].userAdjusted 
                                  ? next[p].width 
                                  : (type === 'CDWI' && volumeDefaults['ACQUIRED_HIGH_REF']
                                      ? Math.max(1, volumeDefaults['ACQUIRED_HIGH_REF'].width * Math.exp(-(bTarget - bHigh) * refAdcForWindow * 1e-3))
                                      : volumeDefaults[type]?.width || 1);
                                const currentCenter = next[p].userAdjusted 
                                  ? next[p].center 
                                  : (type === 'CDWI' && volumeDefaults['ACQUIRED_HIGH_REF']
                                      ? Math.max(1, volumeDefaults['ACQUIRED_HIGH_REF'].width * Math.exp(-(bTarget - bHigh) * refAdcForWindow * 1e-3)) / 2
                                      : volumeDefaults[type]?.center || 0);
                                      
                                const dwc = dy * (currentWidth / 200);
                                const dww = dx * (currentWidth / 200);
                                
                                next[p] = {
                                  center: currentCenter + dwc,
                                  width: Math.max(0.000001, currentWidth + dww),
                                  userAdjusted: true
                                };
                              }
                            }
                            return next;
                          });
                        }
                      }}
                      onResetWindow={() => {
                        setWindowStates(prev => {
                          const next = [...prev];
                          next[i] = { ...next[i], userAdjusted: false };
                          return next;
                        });
                      }}
                      syncTransform={syncPanels ? syncTransform : undefined}
                      onTransform={(zoom, panX, panY, sourceId) => {
                        if (syncPanels) setSyncTransform({ zoom, panX, panY, sourceId, ts: Date.now() });
                      }}
                      rois={rois.filter(r => r.sliceIndex === currentSlice)}
                      draftRoi={draftRoi}
                      activeTool={activeTool}
                      onRoiStart={(p) => {
                        const roiColors = ['#00ff00', '#ff00ff', '#00ffff', '#ffff00', '#ff0000', '#0000ff'];
                        const nextColor = roiColors[rois.length % roiColors.length];
                        setActivePanelIndex(i);
                        setDraftRoi({
                          id: Math.random().toString(36).substring(2, 9),
                          label: 'ROI ' + (rois.length + 1),
                          color: nextColor,
                          shape: activeTool!,
                          geometry: [p, p],
                          sliceIndex: currentSlice
                        });
                      }}
                      onRoiMove={(p) => {
                        if (draftRoi && draftRoi.shape !== 'polygon') {
                          setDraftRoi({ ...draftRoi, geometry: [draftRoi.geometry[0], p] });
                        }
                      }}
                      onRoiEnd={() => {
                        if (draftRoi) {
                          if (draftRoi.shape !== 'polygon') {
                            setRois([...rois, draftRoi]);
                            setDraftRoi(null);
                            setActiveTool(null);
                          } else if (draftRoi.shape === 'polygon' && draftRoi.geometry.length > 2) {
                            setRois([...rois, draftRoi]);
                            setDraftRoi(null);
                            setActiveTool(null);
                          }
                        }
                      }}
                      onRoiAddPoint={(p) => {
                        setActivePanelIndex(i);
                        if (!draftRoi) {
                          const roiColors = ['#00ff00', '#ff00ff', '#00ffff', '#ffff00', '#ff0000', '#0000ff'];
                          const nextColor = roiColors[rois.length % roiColors.length];
                          setDraftRoi({
                            id: Math.random().toString(36).substring(2, 9),
                            label: 'ROI ' + (rois.length + 1),
                            color: nextColor,
                            shape: activeTool!,
                            geometry: [p],
                            sliceIndex: currentSlice
                          });
                        } else {
                          setDraftRoi({ ...draftRoi, geometry: [...draftRoi.geometry, p] });
                        }
                      }}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="bg-[#2B221C] p-3 border-t border-[#3a3028] flex items-center gap-6 shrink-0 z-10">
        <div className="flex items-center gap-2 w-64">
          <label className="text-xs font-semibold whitespace-nowrap">{es.slice} {currentSlice + 1} / {meta?.sliceCount || 0}</label>
          <input type="range" min={0} max={(meta?.sliceCount || 1) - 1} value={currentSlice}
            onChange={e => setCurrentSlice(Number(e.target.value))}
            className="w-full accent-[#F27D26]"
            disabled={!meta || meta.sliceCount === 0}
          />
        </div>
        
        <div className="flex items-center gap-2 w-64">
          <label className="text-xs font-semibold whitespace-nowrap">{es.targetB}: {bTarget}</label>
          <input type="range" min={0} max={3000} step={50} value={bTarget}
            onChange={e => {
              setBTarget(Number(e.target.value));
              triggerRecompute({ bTarget: Number(e.target.value) });
            }}
            className="w-full accent-[#F27D26]"
            disabled={!meta}
          />
        </div>
        
        {bTarget > 2000 && (
          <div className="text-amber-500 text-[10px] flex-1 leading-tight">{es.warnHighTargetB}</div>
        )}

        <div className="text-[10px] text-gray-500 max-w-sm text-right ml-auto">
          {es.disclaimer}
          <span className="ml-2 opacity-70">
            v{__APP_VERSION__} · {__BUILD_DATE__}
          </span>
        </div>
      </div>
    </div>
  );
}
