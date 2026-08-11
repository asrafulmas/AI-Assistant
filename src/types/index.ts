import { Context } from 'telegraf';
import { Update } from 'telegraf/typings/core/types/typegram';

export type ErrorCategory =
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'service_unavailable'
  | 'timeout'
  | 'invalid_request'
  | 'unknown';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AIResponse {
  text: string;
  finishReason?: string;
  model?: string;
}

export interface ValidationResult {
  key1Valid: boolean;
  key2Valid: boolean | null;
  currentModel: string;
  validatedModels: string[];
}

export type Language = 'hinglish' | 'hindi' | 'english' | 'arabic' | 'french' | 'urdu';

export interface SessionData {
  mode?: string;
  botMessageIds?: number[];
  translationMode?: boolean;
  awaitingTranslation?: boolean;
  awaitingImagePrompt?: boolean;
  awaitingChannelUsername?: boolean;
  awaitingSettingKey?: string | null;
  awaitingBroadcastMessage?: boolean;
  broadcastMessageInfo?: any;
  awaitingPaymentScreenshot?: boolean;
  awaitingUpiIdInput?: boolean;
  awaitingManualPremiumUserId?: boolean;
  awaitingChannelAddInput?: boolean;
  awaitingChannelRemoveId?: string;
  language?: Language;
}

export interface BroadcastResult {
  total: number;
  success: number;
  failed: number;
  errors: string[];
}

export interface BotState {
  dbUser?: {
    id: bigint;
    telegramId: bigint;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    isPremium: boolean;
    isAdmin: boolean;
    isOwner: boolean;
  };
  isOwner?: boolean;
  isAdmin?: boolean;
}

export type BotContext = Context<Update> & {
  session: SessionData;
  state: BotState;
};
