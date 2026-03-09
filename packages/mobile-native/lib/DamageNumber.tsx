/**
 * DamageNumber — Animated floating damage number component.
 * Style spec from Art Director (UCFA-25).
 */

import React, { useEffect, useRef } from "react";
import { Animated, Easing, type ViewStyle, type TextStyle } from "react-native";

export type DamageNumberEntry = {
  id: string;
  damage: number;
  isHealing: boolean;
  /** Horizontal offset from center of parent container */
  offsetX: number;
  /** Vertical offset from top of parent container */
  offsetY: number;
};

const LIFETIME_MS = 1800;
const FADE_START_MS = 1000;
const FLOAT_DISTANCE = -80;

const CRIT_THRESHOLD = 35;
const HEAVY_THRESHOLD = 15;

function getDamageColor(damage: number, isHealing: boolean): string {
  if (isHealing) return "#4ade80";
  if (damage >= CRIT_THRESHOLD) return "#ef4444";
  if (damage >= HEAVY_THRESHOLD) return "#f59e0b";
  return "#e7e5e4";
}

function getDamageShadowColor(damage: number, isHealing: boolean): string {
  if (isHealing) return "rgba(34,197,94,0.7)";
  if (damage >= CRIT_THRESHOLD) return "rgba(239,68,68,0.9)";
  if (damage >= HEAVY_THRESHOLD) return "rgba(217,119,6,0.8)";
  return "rgba(0,0,0,0.9)";
}

function getDamageShadowRadius(damage: number, isHealing: boolean): number {
  if (isHealing) return 6;
  if (damage >= CRIT_THRESHOLD) return 10;
  if (damage >= HEAVY_THRESHOLD) return 6;
  return 3;
}

function getDamageFontSize(damage: number, isHealing: boolean): number {
  if (isHealing) return 22;
  const scaleFactor = Math.min(damage / 50, 1);
  return 20 + scaleFactor * 28;
}

type Props = {
  entry: DamageNumberEntry;
  onComplete: (id: string) => void;
};

export function DamageNumber({ entry, onComplete }: Props) {
  const { id, damage, isHealing, offsetX, offsetY } = entry;
  const isCrit = !isHealing && damage >= CRIT_THRESHOLD;

  const scaleAnim = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const critPulseScale = useRef(new Animated.Value(1)).current;
  const shakeX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Phase 1: Pop-in (scale spring + quick opacity fade-in)
    const popIn = Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: 1,
        tension: 180,
        friction: 8,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 80,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]);

    // Phase 2: Float up (runs full lifetime)
    const floatUp = Animated.timing(translateY, {
      toValue: FLOAT_DISTANCE,
      duration: LIFETIME_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });

    // Phase 3: Fade out (starts at FADE_START_MS)
    const fadeOut = Animated.sequence([
      Animated.delay(FADE_START_MS),
      Animated.timing(opacity, {
        toValue: 0,
        duration: LIFETIME_MS - FADE_START_MS,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]);

    // Crit extras: pulse + shake after pop-in settles
    const critExtras = isCrit
      ? Animated.sequence([
          Animated.delay(200), // wait for spring to settle
          Animated.parallel([
            // Scale pulse
            Animated.sequence([
              Animated.spring(critPulseScale, {
                toValue: 1.15,
                tension: 300,
                friction: 10,
                useNativeDriver: true,
              }),
              Animated.spring(critPulseScale, {
                toValue: 1,
                tension: 300,
                friction: 10,
                useNativeDriver: true,
              }),
            ]),
            // Shake
            Animated.sequence([
              Animated.timing(shakeX, { toValue: -3, duration: 33, useNativeDriver: true }),
              Animated.timing(shakeX, { toValue: 3, duration: 33, useNativeDriver: true }),
              Animated.timing(shakeX, { toValue: -2, duration: 33, useNativeDriver: true }),
              Animated.timing(shakeX, { toValue: 2, duration: 33, useNativeDriver: true }),
              Animated.timing(shakeX, { toValue: 0, duration: 33, useNativeDriver: true }),
            ]),
          ]),
        ])
      : Animated.delay(0);

    Animated.parallel([popIn, floatUp, fadeOut, critExtras]).start(({ finished }) => {
      if (finished) onComplete(id);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const containerStyle: Animated.WithAnimatedObject<ViewStyle> = {
    position: "absolute",
    left: offsetX,
    top: offsetY,
    zIndex: 50,
    pointerEvents: "none",
    alignItems: "center",
    transform: [
      { translateY },
      {
        scale: Animated.multiply(
          scaleAnim.interpolate({
            inputRange: [0, 1],
            outputRange: [0, isCrit ? 1.5 : 1.3],
          }),
          critPulseScale,
        ),
      },
      { translateX: shakeX },
    ],
    opacity,
  };

  const textStyle: TextStyle = {
    fontFamily: "MostWazted",
    fontSize: getDamageFontSize(damage, isHealing),
    color: getDamageColor(damage, isHealing),
    textShadowColor: getDamageShadowColor(damage, isHealing),
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: getDamageShadowRadius(damage, isHealing),
    textAlign: "center",
  };

  const displayText = isHealing
    ? `+${damage}`
    : isCrit
      ? `CRIT ${damage}`
      : `-${damage}`;

  return (
    <Animated.View style={containerStyle}>
      <Animated.Text style={textStyle}>{displayText}</Animated.Text>
    </Animated.View>
  );
}
