import axios from 'axios';
import { createHash } from 'crypto';

/**
 * Visual Generation Service for AI Battle Arena
 * Generates robot fight images based on battle state
 */

export interface VisualConfig {
  provider: 'replicate' | 'openai' | 'stability' | 'local';
  apiKey: string;
  model?: string;
}

export interface BattleFrame {
  matchId: number;
  round: number;
  turn: number;
  playerA: {
    name: string;
    visualPrompt: string;
    hp: number;
    move: string;
  };
  playerB: {
    name: string;
    visualPrompt: string;
    hp: number;
    move: string;
  };
  result: string;
  damageDealt: number;
}

export class VisualGenerator {
  private config: VisualConfig;

  constructor(config: VisualConfig) {
    this.config = config;
  }

  /**
   * Generate a deterministic visual seed for the frame
   * This ensures the same battle state always generates the same visual style
   */
  generateVisualSeed(frame: BattleFrame): string {
    const seedData = `
      ${frame.matchId}-${frame.round}-${frame.turn}
      ${frame.playerA.visualPrompt}
      ${frame.playerB.visualPrompt}
      ${frame.playerA.move}-vs-${frame.playerB.move}
    `;
    return createHash('sha256').update(seedData).digest('hex').slice(0, 16);
  }

  /**
   * Build the image prompt based on battle action - Real Steel Style
   */
  buildPrompt(frame: BattleFrame): string {
    const { playerA, playerB, result, damageDealt } = frame;

    // Real Steel inspired action descriptions
    let actionDesc = '';
    let cameraAngle = '';

    if (result.includes('TRADE')) {
      actionDesc = `both robots trading devastating punches simultaneously, boxing gloves colliding mid-air, massive impact shockwave, metal crunching, sparks exploding from contact point`;
      cameraAngle = 'dramatic side angle capturing both fighters, motion blur on gloves';
    } else if (result.includes('BLOCKED')) {
      actionDesc = `defender's boxing gloves raised in perfect defensive guard, attacker's glove deflecting off with force, shock absorption ripples, defensive technique showcase`;
      cameraAngle = 'low angle hero shot emphasizing the block';
    } else if (result.includes('HIT')) {
      const intensity = damageDealt > 30 ? 'catastrophic' : damageDealt > 20 ? 'brutal' : 'solid';
      actionDesc = `${intensity} haymaker punch connecting to head unit, defender's head snapping back, boxing glove impact crater forming, oil spray, debris flying, dramatic slow-motion moment`;
      cameraAngle = 'cinematic close-up of impact, dynamic angle';
    } else if (result.includes('DODGED')) {
      actionDesc = `agile robot weaving under a massive swing, attacker's glove whooshing past, defensive footwork, counter-positioning, fluid mechanical movement`;
      cameraAngle = 'action shot from behind the dodger';
    } else if (result.includes('CAUGHT')) {
      actionDesc = `counter-fighter catching opponent with a surprise hook, glove connecting during dodge, momentum reversal, tactical boxing mastery`;
      cameraAngle = 'dramatic side profile of the counter punch';
    } else if (result.includes('SPECIAL')) {
      actionDesc = `FINISHER MOVE - haymaker uppercut with maximum power, all servos firing, glove glowing from friction heat, devastating impact creating shockwave that ripples the floor, oil and metal fragments exploding, movie climax moment`;
      cameraAngle = 'epic low angle hero shot, dramatic backlighting';
    } else {
      actionDesc = `both robots in defensive stances, gloves up, circling each other, tense standoff`;
      cameraAngle = 'wide shot showing both fighters';
    }

    // Damage state descriptions (Real Steel style wear and tear)
    const stateA = playerA.hp > 70 ? 'pristine condition, minor scuffs' :
                   playerA.hp > 40 ? 'moderate battle damage - dented armor, cracked plating, oil leaking from joints' :
                   playerA.hp > 15 ? 'heavy damage - crushed sections, exposed hydraulics, sparking wires, severe dents' :
                   'critical failure state - barely standing, massive structural damage, systems failing, one punch from shutdown';

    const stateB = playerB.hp > 70 ? 'pristine condition, minor scuffs' :
                   playerB.hp > 40 ? 'moderate battle damage - dented armor, cracked plating, oil leaking from joints' :
                   playerB.hp > 15 ? 'heavy damage - crushed sections, exposed hydraulics, sparking wires, severe dents' :
                   'critical failure state - barely standing, massive structural damage, systems failing, one punch from shutdown';

    const prompt = `
Photorealistic robot boxing match in the style of Real Steel movie. Gritty, industrial, dramatic lighting.

FIGHTER A: ${playerA.visualPrompt}
Battle Condition: ${stateA}
CRITICAL: Robot MUST have visible boxing gloves on both hands

FIGHTER B: ${playerB.visualPrompt}
Battle Condition: ${stateB}
CRITICAL: Robot MUST have visible boxing gloves on both hands

COMBAT ACTION: ${actionDesc}

ARENA: Underground illegal fighting pit - exposed steel beams, chain-link fence cage walls,
single hanging industrial work light creating harsh shadows, oil-stained concrete floor with cracks,
steam venting from pipes, abandoned warehouse aesthetic, gritty realistic textures,
sparse crowd in deep shadows, money and betting slips scattered, urban decay atmosphere.

CAMERA: ${cameraAngle}

STYLE: Photorealistic, Real Steel movie aesthetic, dramatic cinematic lighting with harsh shadows,
practical effects look, visible impact physics, metal-on-metal realism, oil and hydraulic fluid,
sparks with realistic trajectory, motion blur only on fast-moving parts,
gritty color grading with desaturated tones and orange/teal contrast, 8K detail, film grain.

LIGHTING: Single overhead industrial light as key light, rim lighting from background flames or sparks,
deep shadows, high contrast, noir-inspired dramatic lighting.

CRITICAL REQUIREMENTS: Both robots MUST have boxing gloves clearly visible, photorealistic metal textures,
Real Steel movie quality, no cartoon/anime style.
    `.trim();

    return prompt;
  }

  /**
   * Generate image via Replicate (FLUX or SD)
   */
  async generateReplicate(prompt: string, seed: string): Promise<string> {
    // FLUX.1 or Stable Diffusion on Replicate
    const model = this.config.model || 'black-forest-labs/flux-schnell';
    
    const response = await axios.post(
      'https://api.replicate.com/v1/predictions',
      {
        version: model,
        input: {
          prompt,
          seed: parseInt(seed, 16) % 1000000,
          aspect_ratio: '16:9',
          output_format: 'png'
        }
      },
      {
        headers: {
          'Authorization': `Token ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Poll for result
    const predictionId = response.data.id;
    let result = await this.pollReplicate(predictionId);
    
    return result.output?.[0] || result.output;
  }

  /**
   * Generate via OpenAI DALL-E
   */
  async generateOpenAI(prompt: string): Promise<string> {
    const model = this.config.model || 'dall-e-3';
    
    const response = await axios.post(
      'https://api.openai.com/v1/images/generations',
      {
        model,
        prompt,
        size: '1792x1024', // 16:9
        quality: 'standard',
        n: 1
      },
      {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.data[0].url;
  }

  /**
   * Generate battle frame image
   */
  async generateFrame(frame: BattleFrame): Promise<{
    imageUrl: string;
    seed: string;
    prompt: string;
    metadata: {
      matchId: number;
      round: number;
      turn: number;
      timestamp: number;
    }
  }> {
    const seed = this.generateVisualSeed(frame);
    const prompt = this.buildPrompt(frame);
    
    let imageUrl: string;
    
    switch (this.config.provider) {
      case 'replicate':
        imageUrl = await this.generateReplicate(prompt, seed);
        break;
      case 'openai':
        imageUrl = await this.generateOpenAI(prompt);
        break;
      default:
        throw new Error(`Provider ${this.config.provider} not implemented`);
    }

    return {
      imageUrl,
      seed,
      prompt,
      metadata: {
        matchId: frame.matchId,
        round: frame.round,
        turn: frame.turn,
        timestamp: Date.now()
      }
    };
  }

  private async pollReplicate(predictionId: string, maxAttempts = 60): Promise<any> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 1000));

      const response = await axios.get(
        `https://api.replicate.com/v1/predictions/${predictionId}`,
        { headers: { 'Authorization': `Token ${this.config.apiKey}` } }
      );

      if (response.data.status === 'succeeded') {
        console.log('[Replicate] Generation completed:', predictionId);
        return response.data;
      }

      if (response.data.status === 'failed') {
        console.error('[Replicate] Generation failed:', {
          predictionId,
          error: response.data.error,
          logs: response.data.logs
        });
        throw new Error(`Replicate generation failed: ${response.data.error || 'Unknown error'}`);
      }
    }

    console.error('[Replicate] Polling timeout after', maxAttempts, 'attempts for', predictionId);
    throw new Error(`Replicate polling timeout after ${maxAttempts} seconds`);
  }
}

/**
 * IPFS/Storage helper for persisting visuals
 */
export class VisualStorage {
  /**
   * Upload to IPFS via Pinata or similar
   */
  async uploadToIPFS(imageUrl: string, metadata: any): Promise<string> {
    // Fetch image
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageResponse.data);
    
    // Upload to IPFS (implementation depends on provider)
    // This is a placeholder - you'd use Pinata, NFT.Storage, etc.
    const ipfsHash = await this.pinToIPFS(imageBuffer, metadata);
    
    return `ipfs://${ipfsHash}`;
  }

  private async pinToIPFS(buffer: Buffer, metadata: any): Promise<string> {
    // Implement actual IPFS pinning
    // Placeholder return
    return `Qm...${Date.now()}`;
  }
}

export default VisualGenerator;