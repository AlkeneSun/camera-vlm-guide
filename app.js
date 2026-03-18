/**
 * Camera VLM Sequential Object Recognition
 * 
 * State machine: IDLE → SCANNING → DETECTED → COMPLETE
 * Captures frames from camera, sends to VLM API for recognition,
 * enforces strict sequential ordering of object detection.
 */

(() => {
  'use strict';

  // ── VLM Configuration ──
  const VLM_CONFIG = {
    model: 'Qwen/Qwen3.5-35B-A3B',
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
  };

  // ── DOM References ──
  const $ = (sel) => document.querySelector(sel);
  const dom = {
    setupScreen: $('#setup-screen'),
    cameraScreen: $('#camera-screen'),
    completeScreen: $('#complete-screen'),
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
  };

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
    const raw = dom.objectsInput.value.trim();
    if (!raw) {
      showToast('请输入至少一个目标物体', 'error');
      return;
    }

    state.targets = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (state.targets.length === 0) {
      showToast('请输入至少一个目标物体', 'error');
      return;
    }

    state.fps = parseFloat(dom.fpsInput.value) || 1;
    state.confidenceThreshold = parseFloat(dom.confidenceInput.value) || 0.7;
    state.currentIndex = 0;
    state.history = [];
    state.isProcessing = false;

    try {
      await startCamera();
      state.phase = 'SCANNING';
      showScreen('camera-screen');
      updateUI();
      startCapture();
    } catch (err) {
      console.error('Camera error:', err);
      showToast('无法访问摄像头: ' + err.message, 'error');
    }
  });

  // ── Stop ──
  dom.stopBtn.addEventListener('click', () => {
    stopCapture();
    stopCamera();
    state.phase = 'IDLE';
    showScreen('setup-screen');
  });

  // ── Restart ──
  dom.restartBtn.addEventListener('click', () => {
    state.phase = 'IDLE';
    state.currentIndex = 0;
    state.history = [];
    showScreen('setup-screen');
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
  //  Frame Extraction
  // ──────────────────────────────────────

  function captureFrame() {
    const video = dom.video;
    if (video.readyState < 2) return null;

    const canvas = dom.canvas;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    // Export as base64 JPEG, quality 0.7
    return canvas.toDataURL('image/jpeg', 0.7);
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

  async function callVLM(imageBase64, targetObject) {
    const prompt = `Look at this image carefully. Does this image contain "${targetObject}"?
Reply ONLY with a JSON object in this exact format, no other text:
{"found": true, "confidence": 0.95, "description": "brief description of what you see"}
If the object is not present, set found to false and confidence to a low number.`;

    const body = {
      model: VLM_CONFIG.model,
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
      max_tokens: 200,
      temperature: 0.1,
    };

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

    // Parse JSON from response, handle potential wrapping text
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      console.warn('Could not parse VLM response:', text);
      return { found: false, confidence: 0, description: text };
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn('JSON parse error:', e, text);
      return { found: false, confidence: 0, description: text };
    }
  }

  // ──────────────────────────────────────
  //  Sequential Logic
  // ──────────────────────────────────────

  async function processFrame() {
    if (state.isProcessing || state.phase !== 'SCANNING') return;
    state.isProcessing = true;

    dom.statusText.textContent = '正在分析...';

    try {
      const frameData = captureFrame();
      if (!frameData) {
        state.isProcessing = false;
        return;
      }

      const currentTarget = state.targets[state.currentIndex];
      const result = await callVLM(frameData, currentTarget);

      if (state.phase !== 'SCANNING') {
        state.isProcessing = false;
        return;
      }

      if (result.found && result.confidence >= state.confidenceThreshold) {
        // ✅ Successfully detected current target
        handleDetection(currentTarget, result);
      } else {
        // Not detected — keep scanning
        dom.statusText.textContent = '正在扫描...';
        dom.statusIndicator.className = 'status-dot scanning';
        dom.scanOverlay.className = 'scan-overlay';
      }
    } catch (err) {
      console.error('Frame processing error:', err);
      dom.statusText.textContent = '识别出错，重试中...';
      dom.statusIndicator.className = 'status-dot error';
      showToast('API 调用失败: ' + err.message, 'error');
    } finally {
      state.isProcessing = false;
    }
  }

  function handleDetection(targetName, result) {
    // Record in history
    state.history.push({
      name: targetName,
      timestamp: new Date(),
      confidence: result.confidence,
      description: result.description || '',
    });

    state.currentIndex++;

    // Visual feedback
    dom.scanOverlay.className = 'scan-overlay detected';
    dom.statusIndicator.className = 'status-dot success';
    dom.statusText.textContent = `✓ 已识别: ${targetName}`;

    showToast(`✓ 成功识别: ${targetName} (${(result.confidence * 100).toFixed(0)}%)`, 'success');

    // Add to history list
    addHistoryItem(targetName);

    // Check completion
    if (state.currentIndex >= state.targets.length) {
      // All done!
      setTimeout(() => completeSequence(), 1200);
    } else {
      // Move to next target
      setTimeout(() => {
        dom.scanOverlay.className = 'scan-overlay';
        dom.statusIndicator.className = 'status-dot scanning';
        dom.statusText.textContent = '正在扫描...';
        updateUI();
      }, 1500);
    }
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
  console.log('Camera VLM Guide — Ready');
})();
