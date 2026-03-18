/**
 * Camera VLM Sequential Object Recognition
 * 
 * State machine: IDLE → SCANNING → DETECTED → COMPLETE
 * Captures frames from camera, sends to VLM API for recognition,
 * enforces strict sequential ordering of object detection.
 * 
 * Enhanced with iOS-compatible speech synthesis for real-time voice guidance.
 */

(() => {
  'use strict';

  // ── VLM Configuration ──
  const VLM_CONFIG = {
    // model dynamically read from UI
    baseUrl: 'https://api-inference.modelscope.cn/v1/',
    apiKey: 'ms-9338a713-bf0c-4323-bacc-235bc0cb1dcc',
  };

  // ── App State ──
  const state = {
    phase: 'IDLE', // IDLE | SCANNING | PROCESSING | DETECTED | COMPLETE
    targets: [],
    currentIndex: 0,
    history: [], // { name, timestamp, confidence, description }
    fps: 1,
    confidenceThreshold: 0.7,
    stream: null,
    captureTimer: null,
    isProcessing: false,
    voiceEnabled: true,
    zhVoice: null,        // cached Chinese voice
    speechQueue: [],      // queue to avoid overlapping speech
    isSpeaking: false,
    model: 'Qwen/Qwen3.5-35B-A3B',
  };

  // ── DOM References ──
  const $ = (sel) => document.querySelector(sel);
  const dom = {
    setupScreen: $('#setup-screen'),
    cameraScreen: $('#camera-screen'),
    completeScreen: $('#complete-screen'),
    modelSelect: $('#model-select'),
    objectsInput: $('#objects-input'),
    fpsInput: $('#fps-input'),
    fpsDec: $('#fps-dec'),
    fpsInc: $('#fps-inc'),
    confidenceInput: $('#confidence-input'),
    confidenceValue: $('#confidence-value'),
    startBtn: $('#start-btn'),
    stopBtn: $('#stop-btn'),
    restartBtn: $('#restart-btn'),
    video: $('#camera-video'),
    canvas: $('#capture-canvas'),
    scanOverlay: $('#scan-overlay'),
    statusIndicator: $('#status-indicator'),
    statusText: $('#status-text'),
    currentTarget: $('#current-target'),
    progressBar: $('#progress-bar'),
    progressText: $('#progress-text'),
    historyList: $('#history-list'),
    completeSummary: $('#complete-summary'),
    toastContainer: $('#toast-container'),
    voiceToggle: $('#voice-toggle'),
  };

  // ── Remote Logging ──
  function sendLog(message) {
    try {
      fetch('/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        keepalive: true
      }).catch(() => {});
    } catch(e) {}
  }

  // ──────────────────────────────────────
  //  Speech Synthesis Module (iOS compatible)
  // ──────────────────────────────────────

  /**
   * Initialize Chinese voice. On iOS Safari, voices load async.
   * We prefer zh-CN Tingting or any Chinese voice available.
   */
  function initVoice() {
    const synth = window.speechSynthesis;
    if (!synth) {
      console.warn('SpeechSynthesis not supported');
      state.voiceEnabled = false;
      return;
    }

    function pickVoice() {
      const voices = synth.getVoices();
      // Prefer Chinese voices, prioritize Tingting (iOS built-in)
      const zhVoices = voices.filter(v =>
        v.lang.startsWith('zh') || v.lang.startsWith('cmn')
      );

      if (zhVoices.length > 0) {
        // Prefer iOS Tingting, then any zh-CN, then any zh
        state.zhVoice =
          zhVoices.find(v => v.name.includes('Tingting')) ||
          zhVoices.find(v => v.lang === 'zh-CN') ||
          zhVoices.find(v => v.lang === 'zh-TW') ||
          zhVoices[0];
        console.log('Selected voice:', state.zhVoice.name, state.zhVoice.lang);
      } else if (voices.length > 0) {
        // Fallback to default
        state.zhVoice = null;
        console.warn('No Chinese voice found, using default');
      }
    }

    // Voices may load asynchronously (especially on iOS)
    if (synth.getVoices().length > 0) {
      pickVoice();
    }
    synth.onvoiceschanged = pickVoice;
  }

  /**
   * Speak a message using speech synthesis.
   * Queues messages to avoid overlap. Higher priority interrupts lower.
   * Priority: 0=normal, 1=important, 2=critical (interrupts all)
   */
  function speak(text, priority = 0) {
    if (!state.voiceEnabled || !window.speechSynthesis) return;

    const synth = window.speechSynthesis;

    if (priority >= 2) {
      // Critical: cancel everything and speak immediately
      synth.cancel();
      state.speechQueue = [];
      state.isSpeaking = false;
      _speakNow(text);
      return;
    }

    if (priority >= 1 && state.isSpeaking) {
      // Important: cancel current and speak
      synth.cancel();
      state.isSpeaking = false;
      _speakNow(text);
      return;
    }

    // Normal: queue
    state.speechQueue.push(text);
    if (!state.isSpeaking) {
      _processQueue();
    }
  }

  function _speakNow(text) {
    const synth = window.speechSynthesis;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'zh-CN';
    utter.rate = 1.1;  // Slightly faster for snappy feedback
    utter.pitch = 1.0;
    utter.volume = 1.0;

    if (state.zhVoice) {
      utter.voice = state.zhVoice;
    }

    state.isSpeaking = true;

    utter.onend = () => {
      state.isSpeaking = false;
      _processQueue();
    };

    utter.onerror = (e) => {
      console.warn('Speech error:', e.error);
      state.isSpeaking = false;
      _processQueue();
    };

    // iOS Safari workaround: sometimes synthesis pauses
    // Resume it to prevent stuck state
    synth.speak(utter);

    // iOS Safari bug: long utterances may pause. Keep-alive timer.
    const keepAlive = setInterval(() => {
      if (!state.isSpeaking) {
        clearInterval(keepAlive);
        return;
      }
      if (synth.paused) {
        synth.resume();
      }
    }, 3000);

    utter.onend = () => {
      clearInterval(keepAlive);
      state.isSpeaking = false;
      _processQueue();
    };
  }

  function _processQueue() {
    if (state.speechQueue.length === 0) return;
    const next = state.speechQueue.shift();
    _speakNow(next);
  }

  /**
   * Must be called from a user gesture (click/tap) on iOS
   * to unlock audio context for speech synthesis.
   */
  function unlockSpeech() {
    const synth = window.speechSynthesis;
    if (!synth) return;
    // Speak silent utterance to unlock
    const utter = new SpeechSynthesisUtterance('');
    utter.volume = 0;
    synth.speak(utter);
  }

  // ── Screen Navigation ──
  function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(`#${screenId}`).classList.add('active');
  }

  // ── Toast Notifications ──
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  // ── Voice Toggle ──
  if (dom.voiceToggle) {
    dom.voiceToggle.addEventListener('click', () => {
      state.voiceEnabled = !state.voiceEnabled;
      dom.voiceToggle.classList.toggle('muted', !state.voiceEnabled);
      dom.voiceToggle.setAttribute('aria-label', state.voiceEnabled ? '关闭语音' : '开启语音');
      if (!state.voiceEnabled) {
        window.speechSynthesis?.cancel();
        state.speechQueue = [];
      }
      showToast(state.voiceEnabled ? '🔊 语音提示已开启' : '🔇 语音提示已关闭', 'info');
    });
  }

  // ── FPS Controls ──
  dom.fpsDec.addEventListener('click', () => {
    const v = parseFloat(dom.fpsInput.value);
    if (v > 0.5) dom.fpsInput.value = (v - 0.5).toFixed(1);
  });
  dom.fpsInc.addEventListener('click', () => {
    const v = parseFloat(dom.fpsInput.value);
    if (v < 5) dom.fpsInput.value = (v + 0.5).toFixed(1);
  });

  // ── Confidence Slider ──
  dom.confidenceInput.addEventListener('input', () => {
    dom.confidenceValue.textContent = parseFloat(dom.confidenceInput.value).toFixed(2);
  });

  // ── Start Scanning ──
  dom.startBtn.addEventListener('click', async () => {
    // Unlock speech on user gesture (required for iOS)
    unlockSpeech();

    const raw = dom.objectsInput.value.trim();
    if (!raw) {
      showToast('请输入至少一个目标物体', 'error');
      speak('请输入至少一个目标物体', 1);
      return;
    }

    state.targets = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (state.targets.length === 0) {
      showToast('请输入至少一个目标物体', 'error');
      speak('请输入至少一个目标物体', 1);
      return;
    }

    state.fps = parseFloat(dom.fpsInput.value) || 1;
    state.confidenceThreshold = parseFloat(dom.confidenceInput.value) || 0.7;
    state.model = dom.modelSelect.value;
    state.currentIndex = 0;
    state.history = [];
    state.isProcessing = false;

    try {
      await startCamera();
      state.phase = 'SCANNING';
      showScreen('camera-screen');
      updateUI();
      startCapture();

      // Voice: announce start
      const targetList = state.targets.join('、');
      speak(
        `开始扫描。共有${state.targets.length}个目标: ${targetList}。请先拍摄${state.targets[0]}。`,
        2
      );
    } catch (err) {
      console.error('Camera error:', err);
      showToast('无法访问摄像头: ' + err.message, 'error');
      speak('无法访问摄像头，请检查权限设置', 2);
    }
  });

  // ── Stop ──
  dom.stopBtn.addEventListener('click', () => {
    stopCapture();
    stopCamera();
    state.phase = 'IDLE';
    showScreen('setup-screen');
    speak('扫描已停止', 1);
  });

  // ── Restart ──
  dom.restartBtn.addEventListener('click', () => {
    unlockSpeech();
    state.phase = 'IDLE';
    state.currentIndex = 0;
    state.history = [];
    dom.historyList.innerHTML = '';
    showScreen('setup-screen');
    speak('已重置，可以重新开始', 1);
  });

  // ──────────────────────────────────────
  //  Camera Module
  // ──────────────────────────────────────

  async function startCamera() {
    const constraints = {
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    };

    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    dom.video.srcObject = state.stream;

    return new Promise((resolve) => {
      dom.video.onloadedmetadata = () => {
        dom.video.play();
        resolve();
      };
    });
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    dom.video.srcObject = null;
  }

  // ──────────────────────────────────────
  //  Frame Extraction (optimized for speed)
  // ──────────────────────────────────────

  // Max dimension for exported frame — 480px is plenty for object recognition
  // and keeps base64 payload small (~20-40KB vs ~200KB at full res)
  const FRAME_MAX_WIDTH = 480;
  const FRAME_JPEG_QUALITY = 0.5;

  function captureFrame() {
    const video = dom.video;
    if (video.readyState < 2) return null;

    const srcW = video.videoWidth;
    const srcH = video.videoHeight;

    // Scale down proportionally
    let dstW = srcW;
    let dstH = srcH;
    if (dstW > FRAME_MAX_WIDTH) {
      const ratio = FRAME_MAX_WIDTH / dstW;
      dstW = FRAME_MAX_WIDTH;
      dstH = Math.round(srcH * ratio);
    }

    const canvas = dom.canvas;
    canvas.width = dstW;
    canvas.height = dstH;

    const ctx = canvas.getContext('2d');
    const t0 = performance.now();
    ctx.drawImage(video, 0, 0, dstW, dstH);
    const t1 = performance.now();

    // Export as compressed JPEG
    const data = canvas.toDataURL('image/jpeg', FRAME_JPEG_QUALITY);
    const t2 = performance.now();
    
    return { data, drawMs: t1 - t0, encodeMs: t2 - t1 };
  }

  function startCapture() {
    const interval = 1000 / state.fps;
    state.captureTimer = setInterval(() => {
      if (state.isProcessing || state.phase !== 'SCANNING') return;
      processFrame();
    }, interval);
  }

  function stopCapture() {
    if (state.captureTimer) {
      clearInterval(state.captureTimer);
      state.captureTimer = null;
    }
  }

  // ──────────────────────────────────────
  //  VLM Integration
  // ──────────────────────────────────────

  /**
   * Enhanced prompt: ask VLM to check ALL remaining targets at once,
   * so we can detect wrong-order captures and give corrective feedback.
   */
  async function callVLM(imageBase64, allTargets, currentTarget) {
    const targetListStr = allTargets.map((t, i) => `${i + 1}. "${t}"`).join(', ');

    const prompt = `Task: Object detection. I need to find these objects in order: ${targetListStr}.
Current target: "${currentTarget}".

Reply ONLY with a valid JSON object. No explanation, no markdown formatting outside the JSON block.
Format matches this exact schema:
{
  "current_found": true/false,
  "current_confidence": 0.0-1.0,
  "other_objects_found": ["name"]
}

Rules:
- "current_found": true if "${currentTarget}" is clearly visible.
- "current_confidence": 0.0 to 1.0 (float) confidence level.
- "other_objects_found": list strictly OTHER targets from [${allTargets.join(', ')}] visible in the image. Empty array if none.`;

    const body = {
      model: state.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: imageBase64 },
            },
            {
              type: 'text',
              text: prompt,
            },
          ],
        },
      ],
      max_tokens: 50, // Drastically reduced maximum tokens, since we only need a few JSON tokens
      temperature: 0.1,
    };

    const fetchStart = performance.now();
    const response = await fetch(`${VLM_CONFIG.baseUrl}chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${VLM_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`VLM API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      console.warn('Could not parse VLM response:', text);
      return { current_found: false, current_confidence: 0, other_objects_found: [] };
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        current_found: Boolean(parsed.current_found),
        current_confidence: Number(parsed.current_confidence) || 0,
        other_objects_found: Array.isArray(parsed.other_objects_found) ? parsed.other_objects_found : [],
      };
    } catch (e) {
      console.warn('JSON parse error:', e, text);
      return { current_found: false, current_confidence: 0, other_objects_found: [] };
    }
  }

  // ──────────────────────────────────────
  //  Sequential Logic (Enhanced)
  // ──────────────────────────────────────

  async function processFrame() {
    if (state.isProcessing || state.phase !== 'SCANNING') return;
    state.isProcessing = true;

    dom.statusText.textContent = '正在分析...';

    try {
      const capStart = performance.now();
      const frameResult = captureFrame();
      const capEnd = performance.now();

      if (!frameResult || !frameResult.data) {
        state.isProcessing = false;
        return;
      }

      const frameData = frameResult.data;
      const currentTarget = state.targets[state.currentIndex];
      // Get remaining targets (current + future) for wrong-order detection
      const remainingTargets = state.targets.slice(state.currentIndex);

      const vlmStart = performance.now();
      const result = await callVLM(frameData, remainingTargets, currentTarget);
      const vlmEnd = performance.now();

      // Send performance log
      const totalProcess = (vlmEnd - capStart).toFixed(1);
      const capTotal = (capEnd - capStart).toFixed(1);
      const vlmTotal = (vlmEnd - vlmStart).toFixed(1);
      const payloadSize = Math.round(frameData.length / 1024);
      
      const logMsg = `[PERF] Total: ${totalProcess}ms | Capture: ${capTotal}ms (Draw: ${frameResult.drawMs.toFixed(1)}ms, Encode: ${frameResult.encodeMs.toFixed(1)}ms) | Payload: ${payloadSize}KB | API: ${vlmTotal}ms`;
      console.log(logMsg);
      sendLog(logMsg);

      if (state.phase !== 'SCANNING') {
        state.isProcessing = false;
        return;
      }

      if (result.current_found && result.current_confidence >= state.confidenceThreshold) {
        // ✅ Correct object detected!
        handleDetection(currentTarget, result);
      } else if (result.other_objects_found && result.other_objects_found.length > 0) {
        // ⚠️ Wrong order: detected a future target, not the current one
        handleWrongOrder(currentTarget, result.other_objects_found, result);
      } else {
        // Nothing detected — keep scanning
        dom.statusText.textContent = '正在扫描...';
        dom.statusIndicator.className = 'status-dot scanning';
        dom.scanOverlay.className = 'scan-overlay';
      }
    } catch (err) {
      console.error('Frame processing error:', err);
      dom.statusText.textContent = '识别出错，重试中...';
      dom.statusIndicator.className = 'status-dot error';
      showToast('API 调用失败: ' + err.message, 'error');
      speak('网络识别出错，正在重试', 0);
    } finally {
      state.isProcessing = false;
    }
  }

  function handleDetection(targetName, result) {
    // Record in history
    state.history.push({
      name: targetName,
      timestamp: new Date(),
      confidence: result.current_confidence,
      description: result.description || '',
    });

    state.currentIndex++;

    const done = state.currentIndex;
    const total = state.targets.length;
    const remaining = total - done;

    // Visual feedback
    dom.scanOverlay.className = 'scan-overlay detected';
    dom.statusIndicator.className = 'status-dot success';
    dom.statusText.textContent = `✓ 已识别: ${targetName}`;

    showToast(`✓ 成功识别: ${targetName} (${(result.current_confidence * 100).toFixed(0)}%)`, 'success');

    // Add to history list
    addHistoryItem(targetName);

    // Check completion
    if (done >= total) {
      // 🎉 All done!
      speak(
        `太棒了！成功识别到${targetName}！全部${total}个目标已完成！恭喜你！`,
        2
      );
      setTimeout(() => completeSequence(), 1800);
    } else {
      // Voice: report progress and next target
      const nextTarget = state.targets[state.currentIndex];
      speak(
        `识别到${targetName}，完成${done}个，还剩${remaining}个。请拍摄下一个目标: ${nextTarget}。`,
        1
      );

      // Move to next target after delay
      setTimeout(() => {
        dom.scanOverlay.className = 'scan-overlay';
        dom.statusIndicator.className = 'status-dot scanning';
        dom.statusText.textContent = '正在扫描...';
        updateUI();
      }, 2000);
    }
  }

  /**
   * Handle wrong-order detection: user pointed camera at a future target
   * instead of the current one. Give corrective voice + visual feedback.
   */
  function handleWrongOrder(expectedTarget, foundObjects, result) {
    const wrongNames = foundObjects.join('、');

    // Visual feedback — error state
    dom.scanOverlay.className = 'scan-overlay error';
    dom.statusIndicator.className = 'status-dot error';
    dom.statusText.textContent = `✗ 顺序错误！请先拍 ${expectedTarget}`;

    showToast(`⚠️ 检测到 ${wrongNames}，但需要先拍 ${expectedTarget}`, 'error');

    // Voice correction — important priority to interrupt
    speak(
      `顺序不对。我看到了${wrongNames}，但现在需要先拍摄${expectedTarget}。请对准${expectedTarget}。`,
      1
    );

    // Reset to scanning state after delay
    setTimeout(() => {
      if (state.phase === 'SCANNING') {
        dom.scanOverlay.className = 'scan-overlay';
        dom.statusIndicator.className = 'status-dot scanning';
        dom.statusText.textContent = '正在扫描...';
      }
    }, 3000);
  }

  function addHistoryItem(name) {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <div class="check">
        <svg viewBox="0 0 12 12" fill="none">
          <polyline points="2,6 5,9 10,3" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <span class="name">${name}</span>
      <span class="time">${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
    `;
    dom.historyList.appendChild(item);

    // Scroll to bottom
    const section = $('#history-section');
    section.scrollTop = section.scrollHeight;
  }

  function completeSequence() {
    state.phase = 'COMPLETE';
    stopCapture();
    stopCamera();

    const total = state.history.length;

    // Build summary
    dom.completeSummary.innerHTML = state.history
      .map(
        (h, i) => `
      <div class="summary-item">
        <div class="index">${i + 1}</div>
        <div class="info">
          <span class="name">${h.name}</span>
          <span class="meta">置信度: ${(h.confidence * 100).toFixed(0)}% · ${h.timestamp.toLocaleTimeString('zh-CN')}</span>
        </div>
      </div>
    `
      )
      .join('');

    showScreen('complete-screen');

    // Final completion voice (delayed to let UI animate)
    setTimeout(() => {
      const names = state.history.map(h => h.name).join('、');
      speak(
        `任务完成！你已经按顺序成功拍摄了全部${total}个目标: ${names}。做得太好了！`,
        2
      );
    }, 800);
  }

  // ──────────────────────────────────────
  //  UI Updates
  // ──────────────────────────────────────

  function updateUI() {
    if (state.phase === 'SCANNING' || state.phase === 'PROCESSING') {
      const current = state.targets[state.currentIndex];
      dom.currentTarget.textContent = current || '—';

      const total = state.targets.length;
      const done = state.currentIndex;
      dom.progressBar.style.width = `${(done / total) * 100}%`;
      dom.progressText.textContent = `${done} / ${total}`;
    }
  }

  // ── Init ──
  initVoice();
  console.log('Camera VLM Guide — Ready (with voice)');
})();
