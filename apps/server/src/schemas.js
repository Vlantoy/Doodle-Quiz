import { z } from "zod";

const hotspotSchema = z.object({
  xRatio: z.number().min(0).max(1),
  yRatio: z.number().min(0).max(1),
  wRatio: z.number().min(0).max(1),
  hRatio: z.number().min(0).max(1)
});

export const questionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  canvasImage: z.string().optional().default(""),
  movableBlocks: z.array(z.object({
    id: z.string(),
    text: z.string(),
    xRatio: z.number().min(0).max(1),
    yRatio: z.number().min(0).max(1),
    canMoveByPlayers: z.boolean().default(false)
  })).default([]),
  targetZones: z.array(hotspotSchema).optional().default([]),
  gauge: z.object({
    enabled: z.boolean().default(false),
    min: z.number().default(0),
    max: z.number().default(100),
    correctMin: z.number().default(0),
    correctMax: z.number().default(100)
  }).default({ enabled: false, min: 0, max: 100, correctMin: 0, correctMax: 100 }),
  elements: z.array(z.any()).optional().default([]),
  zoomScale: z.number().optional().default(1),
  panOffset: z.object({ x: z.number(), y: z.number() }).optional().default({ x: 0, y: 0 })
});

export const hostRoomSchema = z.object({
  hostPlayerId: z.string().uuid(),
  hostUsername: z.string().trim().min(1).max(24),
  roundDurationSec: z.number().int().min(5).max(180),
  quiz: z.object({
    title: z.string().min(1),
    questions: z.array(questionSchema).min(1)
  })
});

export const joinRoomSchema = z.object({
  roomCode: z.string().length(6),
  playerId: z.string().uuid(),
  username: z.string().trim().min(1).max(24)
});

export const startRoundSchema = z.object({
  roomCode: z.string().length(6),
  hostPlayerId: z.string().uuid(),
  roundIndex: z.number().int().min(0)
});

export const submitRoundSchema = z.object({
  roomCode: z.string().length(6),
  playerId: z.string().uuid(),
  playerToken: z.string().min(1),
  roundIndex: z.number().int().min(0),
  click: z.object({
    rx: z.number().min(0).max(1),
    ry: z.number().min(0).max(1)
  }).nullable().optional(),
  gaugeValue: z.number().nullable().optional(),
  completionMs: z.number().int().min(0).nullable().optional(),
  bet: z.number().int().min(1)
});

export const cleanupRoomSchema = z.object({
  roomCode: z.string().length(6),
  hostPlayerId: z.string().uuid()
});
