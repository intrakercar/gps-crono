// App.tsx — Expo React Native (TypeScript)
// Funciones: máx/medio de velocidad vía GPS + cronos 0→X km/h (40..200)
// Nota: pensado para usar en circuito/carretera cerrada. Conduce con responsabilidad.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaView, View, Text, TouchableOpacity, FlatList, AppState } from 'react-native';
import * as Location from 'expo-location';
import { Accuracy, ActivityType } from 'expo-location';

// ====== Utiles ======
const KMH = (mps: number | null | undefined) => (mps ?? 0) * 3.6;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// Haversine (metros)
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000; // m
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Suavizado EMA simple para velocidad (reduce ruido de GPS)
class EmaFilter {
  private alpha: number; private y: number | null = null;
  constructor(alpha = 0.25) { this.alpha = clamp(alpha, 0.05, 0.9); }
  next(x: number) { this.y = this.y === null ? x : this.alpha * x + (1 - this.alpha) * this.y; return this.y; }
  reset() { this.y = null; }
}

// ====== Parámetros ======
const SPEED_THRESHOLDS = [40, 60, 80, 100, 120, 140, 160, 180, 200]; // km/h
const STOP_KMH = 1.0; // por debajo: consideramos detenido
const MOVING_KMH = 3.0; // por encima: consideramos que arrancó (histeresis)

// ====== Tipos ======
interface Split { target: number; t: number | null; }

export default function App() {
  const [hasPerm, setHasPerm] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [armed, setArmed] = useState(false); // esperando que el coche esté parado para armar salida
  const [t0, setT0] = useState<number | null>(null);
  const [splits, setSplits] = useState<Split[]>(SPEED_THRESHOLDS.map(v => ({ target: v, t: null })));
  const [maxKmh, setMaxKmh] = useState(0);
  const [avgKmh, setAvgKmh] = useState(0);
  const [currKmh, setCurrKmh] = useState(0);
  const [distanceM, setDistanceM] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [fixInfo, setFixInfo] = useState<{ acc?: number; sat?: number; } | null>(null);

  const lastPoint = useRef<Location.LocationObjectCoords | null>(null);
  const ema = useRef(new EmaFilter(0.25));
  const subRef = useRef<Location.LocationSubscription | null>(null);
  const appState = useRef(AppState.currentState);

  // ====== Permisos ======
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      setHasPerm(status === 'granted');
    })();
  }, []);

  // Pausar/reanudar si app va a background
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (appState.current.match(/active/) && next.match(/inactive|background/)) {
        // nada especial; seguimos midiendo en foreground
      }
      appState.current = next;
    });
    return () => sub.remove();
  }, []);

  // ====== Control ======
  const resetAll = useCallback(() => {
    setRunning(false); setArmed(false); setT0(null);
    setSplits(SPEED_THRESHOLDS.map(v => ({ target: v, t: null })));
    setMaxKmh(0); setAvgKmh(0); setCurrKmh(0); setDistanceM(0); setElapsedMs(0);
    ema.current.reset();
    lastPoint.current = null;
    subRef.current?.remove(); subRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (!hasPerm) return;
    setArmed(true); setRunning(true);
    setSplits(SPEED_THRESHOLDS.map(v => ({ target: v, t: null })));
    setMaxKmh(0); setAvgKmh(0); setCurrKmh(0); setDistanceM(0); setElapsedMs(0);
    ema.current.reset(); lastPoint.current = null; setT0(null);

    // Alta frecuencia + mejor precisión disponible
    const sub = await Location.watchPositionAsync({
      accuracy: Accuracy.BestForNavigation,
      timeInterval: 200, // ms
      distanceInterval: 0.5, // metros
      mayShowUserSettingsDialog: true,
      activityType: ActivityType.AutomotiveNavigation,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: false,
    }, (loc) => {
      const { coords, timestamp } = loc;
      const speedKmhRaw = KMH(coords.speed);
      const speedKmh = ema.current.next(speedKmhRaw);
      const now = typeof timestamp === 'number' ? timestamp : new Date(timestamp as any).getTime();

      setFixInfo({ acc: coords.accuracy, sat: (coords as any).satellitesUsed });
      setCurrKmh(speedKmh);
      setMaxKmh((m) => Math.max(m, speedKmh));

      // Distancia y media
      if (lastPoint.current) {
        const d = haversineMeters(lastPoint.current.latitude, lastPoint.current.longitude, coords.latitude, coords.longitude);
        setDistanceM((x) => x + d);
      }
      lastPoint.current = coords;

      // Lógica de arranque desde detenido
      if (armed && t0 === null) {
        // Primero aseguramos que estaba parado recientemente
        if (speedKmh <= STOP_KMH) {
          // aún parado: esperamos a que pase MOVING_KMH
        } else if (speedKmh >= MOVING_KMH) {
          setT0(now);
        }
      }

      // Si ya arrancamos, registrar splits cuando pasamos cada umbral por primera vez
      setSplits((prev) => {
        if (t0 === null) return prev;
        const dt = now - t0; // ms desde salida
        return prev.map((s) => {
          if (s.t !== null) return s;
          if (speedKmh >= s.target) return { ...s, t: dt };
          return s;
        });
      });

      // Tiempo transcurrido para media
      if (t0 !== null) setElapsedMs(now - t0);

      // Velocidad media basada en distancia/tiempo desde t0
      setAvgKmh((curr) => {
        if (t0 === null) return curr;
        const secs = (now - t0) / 1000;
        if (secs <= 0) return 0;
        const km = distanceM / 1000;
        return (km / (secs / 3600));
      });
    });

    subRef.current = sub;
  }, [hasPerm, armed, t0, distanceM]);

  const stop = useCallback(() => {
    subRef.current?.remove();
    subRef.current = null;
    setRunning(false); setArmed(false);
  }, []);

  // ====== UI ======
  const formattedSplits = useMemo(() => splits.map(s => ({
    label: `0 → ${s.target} km/h`,
    value: s.t === null ? '—' : (s.t / 1000).toFixed(2) + ' s'
  })), [splits]);

  if (hasPerm === null) return <SafeAreaView style={{flex:1, backgroundColor:'#0b0b0c'}}/>;
  if (!hasPerm) return (
    <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0b0b0c' }}>
      <Text style={{ color: 'white', fontSize: 18, textAlign:'center', paddingHorizontal:24 }}>
        Necesito permisos de ubicación para medir con el GPS. Concedelos en Ajustes.
      </Text>
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#0b0b0c' }}>
      <View style={{ padding: 16, gap: 10 }}>
        <Text style={{ color: '#a9b1bd', fontSize: 12 }}>EXPERIMENTAL • Solo uso en circuito</Text>
        <Text style={{ color: 'white', fontSize: 28, fontWeight: '700' }}>0→X km/h & GPS Speed</Text>

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <TouchableOpacity
            onPress={running ? stop : start}
            style={{ backgroundColor: running ? '#b91c1c' : '#16a34a', paddingVertical: 12, paddingHorizontal: 18, borderRadius: 14 }}>
            <Text style={{ color: 'white', fontSize: 16, fontWeight: '700' }}>{running ? 'Detener' : 'Start'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={resetAll} style={{ backgroundColor: '#374151', paddingVertical: 12, paddingHorizontal: 18, borderRadius: 14 }}>
            <Text style={{ color: 'white', fontSize: 16, fontWeight: '700' }}>Reset</Text>
          </TouchableOpacity>
        </View>

        <View style={{ marginTop: 10, backgroundColor: '#111827', borderRadius: 18, padding: 16 }}>
          <Text style={{ color: '#9ca3af', fontSize: 12 }}>Velocidad actual</Text>
          <Text style={{ color: 'white', fontSize: 56, fontWeight: '800' }}>{currKmh.toFixed(1)}<Text style={{ fontSize: 18 }}> km/h</Text></Text>

          <View style={{ flexDirection: 'row', gap: 24, marginTop: 8 }}>
            <View>
              <Text style={{ color: '#9ca3af', fontSize: 12 }}>Máxima</Text>
              <Text style={{ color: 'white', fontSize: 20, fontWeight: '700' }}>{maxKmh.toFixed(1)} km/h</Text>
            </View>
            <View>
              <Text style={{ color: '#9ca3af', fontSize: 12 }}>Media</Text>
              <Text style={{ color: 'white', fontSize: 20, fontWeight: '700' }}>{avgKmh.toFixed(1)} km/h</Text>
            </View>
            <View>
              <Text style={{ color: '#9ca3af', fontSize: 12 }}>Distancia</Text>
              <Text style={{ color: 'white', fontSize: 20, fontWeight: '700' }}>{(distanceM/1000).toFixed(3)} km</Text>
            </View>
            <View>
              <Text style={{ color: '#9ca3af', fontSize: 12 }}>Tiempo</Text>
              <Text style={{ color: 'white', fontSize: 20, fontWeight: '700' }}>{(elapsedMs/1000).toFixed(2)} s</Text>
            </View>
          </View>

          {fixInfo && (
            <Text style={{ color: '#6b7280', fontSize: 11, marginTop: 6 }}>Precisión ~{fixInfo.acc?.toFixed(0)} m · sats: {fixInfo.sat ?? '—'}</Text>
          )}
        </View>

        <View style={{ marginTop: 14, backgroundColor: '#111827', borderRadius: 18, padding: 12, maxHeight: 360 }}>
          <FlatList
            data={formattedSplits}
            keyExtractor={(item) => item.label}
            renderItem={({ item }) => (
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 6, borderBottomColor: '#1f2937', borderBottomWidth: 1 }}>
                <Text style={{ color: '#e5e7eb', fontSize: 16 }}>{item.label}</Text>
                <Text style={{ color: '#93c5fd', fontSize: 16, fontVariant: ['tabular-nums'] }}>{item.value}</Text>
              </View>
            )}
          />
          <Text style={{ color: '#6b7280', fontSize: 12, padding: 8 }}>
            Se arma la salida cuando el coche está ≤{STOP_KMH} km/h y el cronómetro arranca al superar {MOVING_KMH} km/h.
          </Text>
        </View>

        <View style={{ marginTop: 8 }}>
          <Text style={{ color: '#9ca3af', fontSize: 12 }}>
            Consejo: para resultados estables, usa cielo abierto y fija el móvil con buen ángulo de visión.
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}
