import React, { useEffect, useRef, useState } from 'react';
import { renderToCanvas } from '../lib/diffusion/render';
import { es } from '../i18n/es';
import { RoiShape, Point, RoiState } from '../lib/roi';
import { getImageMapping } from '../lib/diffusion/coordinates';

interface PanelProps {
  id: number;
  title: string;
  mapType: string;
  pixels?: Float32Array;
  mask?: Uint8Array;
  width: number;
  height: number;
  colormap: 'gray' | 'hot';
  onWheel: (delta: number) => void;
  windowCenter: number;
  windowWidth: number;
  userAdjusted: boolean;
  onWindowChange: (center: number, width: number, userAdjusted: boolean) => void;
  onWlDrag: (dx: number, dy: number) => void;
  syncTransform?: { zoom: number, panX: number, panY: number, sourceId: number, ts: number };
  onTransform?: (zoom: number, panX: number, panY: number, sourceId: number) => void;
  rois?: RoiState[];
  draftRoi?: RoiState | null;
  activeTool?: RoiShape | null;
  onRoiStart?: (p: Point) => void;
  onRoiMove?: (p: Point) => void;
  onRoiEnd?: () => void;
  onRoiAddPoint?: (p: Point) => void;
  onResetWindow: () => void;
}

export function Panel({ 
  id, title, mapType, pixels, width, height, colormap, 
  onWheel, windowCenter, windowWidth, userAdjusted, onWindowChange, onWlDrag, onResetWindow,
  syncTransform, onTransform,
  rois = [], draftRoi = null, activeTool = null,
  onRoiStart, onRoiMove, onRoiEnd, onRoiAddPoint
}: PanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  
  const [isWlDragging, setIsWlDragging] = useState(false);
  const [isPanDragging, setIsPanDragging] = useState(false);
  const [isRoiDragging, setIsRoiDragging] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (syncTransform && syncTransform.sourceId !== id) {
      setZoom(syncTransform.zoom);
      setPanX(syncTransform.panX);
      setPanY(syncTransform.panY);
    }
  }, [syncTransform, id]);

  useEffect(() => {
    if (canvasRef.current && pixels) {
      if ((mapType === 'LOW-B' || mapType === 'HIGH-B' || mapType === 'CDWI') && windowWidth <= 1) {
        // Do not silently render a degenerate window
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
          canvasRef.current.width = width;
          canvasRef.current.height = height;
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, width, height);
        }
      } else {
        renderToCanvas(pixels, width, height, windowCenter, windowWidth, canvasRef.current, colormap);
      }
    }
  }, [pixels, width, height, windowCenter, windowWidth, colormap, mapType]);

  // Render ROIs
  useEffect(() => {
    if (!overlayRef.current) return;
    const ctx = overlayRef.current.getContext('2d');
    if (!ctx) return;
    overlayRef.current.width = width;
    overlayRef.current.height = height;
    ctx.clearRect(0, 0, width, height);

    const allRois = [...rois, ...(draftRoi ? [draftRoi] : [])];

    for (const roi of allRois) {
      if (roi.geometry.length === 0) continue;
      ctx.strokeStyle = roi.color;
      ctx.lineWidth = roi === draftRoi ? 2.0 : 1.0;
      ctx.fillStyle = roi === draftRoi ? 'transparent' : roi.color + '40'; 
      
      ctx.beginPath();
      if (roi.shape === 'circle' && roi.geometry.length === 2) {
        const center = roi.geometry[0];
        const edge = roi.geometry[1];
        const radius = Math.hypot(edge.x - center.x, edge.y - center.y);
        ctx.arc(center.x, center.y, radius, 0, 2 * Math.PI);
      } else if (roi.shape === 'ellipse' && roi.geometry.length >= 2) {
        const center = roi.geometry[0];
        const edge = roi.geometry[1];
        const rx = Math.abs(edge.x - center.x);
        const ry = Math.abs(edge.y - center.y);
        ctx.ellipse(center.x, center.y, rx, ry, 0, 0, 2 * Math.PI);
      } else if (roi.shape === 'polygon' && roi.geometry.length > 0) {
        ctx.moveTo(roi.geometry[0].x, roi.geometry[0].y);
        for (let i = 1; i < roi.geometry.length; i++) {
          ctx.lineTo(roi.geometry[i].x, roi.geometry[i].y);
        }
        if (roi.geometry.length > 2 && roi !== draftRoi) {
          ctx.closePath();
        }
      }
      if (roi !== draftRoi) {
        ctx.fill();
      }
      ctx.stroke();

      ctx.font = "10px sans-serif";
      ctx.fillStyle = roi.color;
      if (roi.geometry[0]) {
        ctx.fillText(roi.label, roi.geometry[0].x + 5, roi.geometry[0].y - 5);
      }
    }
  }, [rois, draftRoi, width, height]);

  const getMousePos = (e: React.MouseEvent | React.TouchEvent, clamp: boolean = true): Point | null => {
    if (!overlayRef.current) return null;
    let clientX = 0, clientY = 0;
    if ('touches' in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    const { offX, offY, scale } = getImageMapping(overlayRef.current.getBoundingClientRect(), width, height);
    let x = (clientX - offX) / scale;
    let y = (clientY - offY) / scale;
    
    if (!clamp) {
      if (x < 0 || x >= width || y < 0 || y >= height) return null;
    }
    x = Math.max(0, Math.min(width - 1, x));
    y = Math.max(0, Math.min(height - 1, y));
    return { x, y };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (activeTool && onRoiStart) {
      if (e.button === 0) {
        const pos = getMousePos(e, false);
        if (!pos) return;
        setIsRoiDragging(true);
        onRoiStart(pos);
        if (activeTool === 'polygon' && onRoiAddPoint) {
          onRoiAddPoint(pos);
        }
      }
      return;
    }

    if (e.button === 2 || e.buttons === 2) {
      setIsWlDragging(true);
      lastPos.current = { x: e.clientX, y: e.clientY };
    } else if (e.button === 0 || e.button === 1) {
      setIsPanDragging(true);
      lastPos.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isWlDragging) {
      const dx = e.clientX - lastPos.current.x;
      const dy = e.clientY - lastPos.current.y;
      lastPos.current = { x: e.clientX, y: e.clientY };
      
      const dwc = dy * (windowWidth / 200);
      const dww = dx * (windowWidth / 200);
      onWindowChange(windowCenter + dwc, Math.max(0.000001, windowWidth + dww), true);
      if (onWlDrag) onWlDrag(dx, dy);
    } else if (isPanDragging) {
      const dx = e.clientX - lastPos.current.x;
      const dy = e.clientY - lastPos.current.y;
      lastPos.current = { x: e.clientX, y: e.clientY };
      
      const newPanX = panX + dx;
      const newPanY = panY + dy;
      setPanX(newPanX);
      setPanY(newPanY);
      if (onTransform) onTransform(zoom, newPanX, newPanY, id);
    } else if (isRoiDragging && onRoiMove) {
      const pos = getMousePos(e, true);
      if (pos) onRoiMove(pos);
    } else if (activeTool === 'polygon' && draftRoi && onRoiMove) {
      const pos = getMousePos(e, true);
      if (pos) onRoiMove(pos);
    }
  };

  const handleMouseUp = () => {
    setIsWlDragging(false);
    setIsPanDragging(false);
    if (isRoiDragging) {
      setIsRoiDragging(false);
      if (onRoiEnd) onRoiEnd();
    }
  };

  const handleDoubleClick = () => {
    setZoom(1);
    setPanX(0);
    setPanY(0);
    if (onTransform) onTransform(1, 0, 0, id);
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      let newZoom = zoom * zoomFactor;
      if (newZoom < 0.5) newZoom = 0.5;
      if (newZoom > 20) newZoom = 20;
      setZoom(newZoom);
      if (onTransform) onTransform(newZoom, panX, panY, id);
    } else {
      onWheel(e.deltaY > 0 ? 1 : -1);
    }
  };

  let cVal = windowCenter;
  let wVal = windowWidth;
  let unit = "";
  let step = 1;

  if (mapType === 'ADC' || mapType === 'VENDOR-ADC') {
    cVal = Math.round(windowCenter * 1e6);
    wVal = Math.round(windowWidth * 1e6);
    unit = " (10⁻⁶ mm²/s)";
    step = 50;
  } else if (mapType === 'EADC' || mapType === 'R2') {
    step = 0.05;
  } else {
    cVal = Math.round(windowCenter);
    wVal = Math.round(windowWidth);
    step = 5;
  }

  const handleCenterChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = parseFloat(e.target.value.replace(',', '.'));
    if (isNaN(val)) val = 0;
    if (mapType === 'ADC' || mapType === 'VENDOR-ADC') val = val / 1e6;
    onWindowChange(val, windowWidth, true);
  };

  const handleWidthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = parseFloat(e.target.value.replace(',', '.'));
    if (isNaN(val)) val = 0;
    if (mapType === 'ADC' || mapType === 'VENDOR-ADC') val = val / 1e6;
    onWindowChange(windowCenter, val, true);
  };

  return (
    <div 
      className="relative flex flex-col h-full min-h-0 border border-[#3a3028] bg-black m-1 overflow-hidden"
      onWheel={handleWheel}
      onContextMenu={e => e.preventDefault()}
    >
      <div className="absolute top-0 left-0 flex flex-col gap-1 items-start z-10 pointer-events-none">
        <div className="bg-black/60 text-[#F27D26] text-xs px-2 py-1 font-semibold rounded-br flex flex-col pointer-events-auto">
          <span>{title}</span>
          {zoom !== 1 && <span className="text-[10px] text-gray-300">{es.zoomLabel}: {zoom.toLocaleString('es-PE', {minimumFractionDigits:1, maximumFractionDigits:1})}×</span>}
        </div>
        {(mapType === 'LOW-B' || mapType === 'HIGH-B' || mapType === 'CDWI') && windowWidth <= 1 && (
          <div 
            className="bg-amber-900/80 border border-amber-500 text-amber-300 text-[10px] px-1.5 py-0.5 rounded ml-1 pointer-events-auto cursor-help"
            title={es.degenerateWindowHelp}
          >
            {es.degenerateWindow}
          </div>
        )}
      </div>
      
      {(mapType === 'ADC' || mapType === 'VENDOR-ADC') && (
        <div className="absolute top-0 right-0 flex gap-1 p-1 z-10 pointer-events-auto">
          <button onClick={() => onWindowChange(1000/1e6, 2000/1e6, true)} className="bg-black/60 hover:bg-[#F27D26] text-gray-300 hover:text-white text-[10px] px-1.5 py-0.5 rounded cursor-pointer transition-colors" title={es.presetProstate}>0-2000</button>
          <button onClick={() => onWindowChange(1500/1e6, 3000/1e6, true)} className="bg-black/60 hover:bg-[#F27D26] text-gray-300 hover:text-white text-[10px] px-1.5 py-0.5 rounded cursor-pointer transition-colors" title={es.presetGeneral}>0-3000</button>
          <button onClick={() => onWindowChange(2000/1e6, 4000/1e6, true)} className="bg-black/60 hover:bg-[#F27D26] text-gray-300 hover:text-white text-[10px] px-1.5 py-0.5 rounded cursor-pointer transition-colors" title={es.presetFluid}>0-4000</button>
        </div>
      )}

      <div 
        ref={containerRef}
        className={`flex-1 min-h-0 flex items-center justify-center overflow-hidden ${activeTool ? 'cursor-crosshair' : 'cursor-default'}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
      >
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <canvas 
            ref={canvasRef} 
            className="absolute inset-0 w-full h-full object-contain" 
            style={{ 
              imageRendering: 'auto',
              transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
              transformOrigin: 'center center'
            }} 
          />
          <canvas 
            ref={overlayRef} 
            className="absolute inset-0 w-full h-full object-contain pointer-events-none" 
            style={{ 
              transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
              transformOrigin: 'center center'
            }} 
          />
        </div>
      </div>
      <div className="absolute bottom-0 right-0 bg-black/60 text-gray-400 text-[10px] p-1 z-10 flex flex-col items-end gap-1">
        <div className="flex items-center gap-1">
          {userAdjusted && (
            <div className="w-1.5 h-1.5 rounded-full bg-amber-500" title={es.userAdjusted} />
          )}
          <span className="font-semibold text-[#F27D26]">{es.windowCenterField}:</span>
          <input 
            type="number" 
            step={step}
            value={mapType === 'EADC' || mapType === 'R2' ? cVal.toFixed(3) : cVal} 
            onChange={handleCenterChange}
            className="bg-transparent border-b border-gray-600 text-right w-12 focus:outline-none focus:border-[#F27D26] no-spinners"
          />
          <span className="font-semibold text-[#F27D26] ml-1">{es.windowWidthField}:</span>
          <input 
            type="number" 
            step={step}
            value={mapType === 'EADC' || mapType === 'R2' ? wVal.toFixed(3) : wVal} 
            onChange={handleWidthChange}
            className="bg-transparent border-b border-gray-600 text-right w-12 focus:outline-none focus:border-[#F27D26] no-spinners"
          />
          <span>{unit}</span>
        </div>
        {userAdjusted && (
          <button 
            onClick={onResetWindow}
            className="text-amber-500 hover:text-amber-400 underline decoration-amber-500/50 cursor-pointer"
          >
            {es.resetWindow}
          </button>
        )}
      </div>
    </div>
  );
}
