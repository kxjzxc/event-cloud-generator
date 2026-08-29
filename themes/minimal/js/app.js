(function() {
  'use strict';

  var STORAGE_KEY = 'tm_unlocked';
  var localStorageOk = (function() {
    try { var t = '__test__'; localStorage.setItem(t, '1'); localStorage.removeItem(t); return true; }
    catch(e) { return false; }
  })();

  function getUnlocked() {
    if (!localStorageOk) return {};
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch(e) {
      return {};
    }
  }

  function unlock(eventId) {
    if (!localStorageOk) return;
    var unlocked = getUnlocked();
    unlocked[eventId] = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(unlocked));
  }

  function isUnlocked(eventId) {
    return eventId in getUnlocked();
  }

  function getEventData() {
    var el = document.getElementById('event-data');
    if (!el) return [];
    try { return JSON.parse(el.textContent); }
    catch(e) { console.error('Failed to parse event data:', e); return []; }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function(m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // ── Global music player (survives card switches) ───────────────
  var musicPlayer = {
    playlist: [],
    index: 0,
    sourceTitle: '',
    playing: false,
    /** 'audio' | 'embed' | null */
    engine: null,
    seeking: false,
    collapsed: false,
  };

  function platformLabel(track) {
    if (!track) return '';
    if (track.platform === 'netease') return '网易云';
    if (track.platform === 'spotify') return 'Spotify';
    return track.platform || '';
  }

  function trackDisplayTitle(track, event) {
    if (!track) return '未知曲目';
    var label = track.title;
    if (!label || /^(网易云|Spotify)/i.test(label)) {
      if (event && event.title) return event.title;
      return platformLabel(track) || '未知曲目';
    }
    return label;
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    var s = Math.floor(seconds);
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function ensureGlobalPlayer() {
    if (document.getElementById('global-player')) return;

    var root = document.createElement('div');
    root.id = 'global-player';
    root.className = 'global-player';
    root.hidden = true;
    root.innerHTML =
      '<div class="gp-bar">' +
        '<div class="gp-now">' +
          '<div class="gp-cover" id="gp-cover" aria-hidden="true"></div>' +
          '<div class="gp-meta">' +
            '<div class="gp-title" id="gp-title">未在播放</div>' +
            '<div class="gp-sub" id="gp-sub"></div>' +
          '</div>' +
        '</div>' +
        '<div class="gp-controls">' +
          '<button type="button" class="gp-btn" id="gp-prev" title="上一首" aria-label="上一首">‹</button>' +
          '<button type="button" class="gp-btn gp-btn-primary" id="gp-toggle" title="播放/暂停" aria-label="播放">▶</button>' +
          '<button type="button" class="gp-btn" id="gp-next" title="下一首" aria-label="下一首">›</button>' +
          '<button type="button" class="gp-btn" id="gp-list-btn" title="播放列表" aria-label="播放列表">☰</button>' +
          '<button type="button" class="gp-btn" id="gp-collapse" title="收起播放器" aria-label="收起播放器" aria-expanded="true">⌄</button>' +
          '<button type="button" class="gp-btn" id="gp-stop" title="停止" aria-label="停止">■</button>' +
        '</div>' +
      '</div>' +
      '<div class="gp-progress" id="gp-progress">' +
        '<span class="gp-time" id="gp-time-cur">0:00</span>' +
        '<input type="range" class="gp-seek" id="gp-seek" min="0" max="0" step="0.1" value="0" disabled aria-label="播放进度">' +
        '<span class="gp-time" id="gp-time-dur">0:00</span>' +
      '</div>' +
      '<div class="gp-embed gp-embed-hidden" id="gp-embed" aria-hidden="true"></div>' +
      '<ul class="gp-playlist" id="gp-playlist" hidden></ul>';
    document.body.appendChild(root);

    document.getElementById('gp-prev').addEventListener('click', function() {
      if (!musicPlayer.playlist.length) return;
      var i = musicPlayer.index - 1;
      if (i < 0) i = musicPlayer.playlist.length - 1;
      playAt(i);
    });
    document.getElementById('gp-next').addEventListener('click', function() {
      if (!musicPlayer.playlist.length) return;
      var i = (musicPlayer.index + 1) % musicPlayer.playlist.length;
      playAt(i);
    });
    document.getElementById('gp-toggle').addEventListener('click', function() {
      if (!musicPlayer.playlist.length) return;
      if (musicPlayer.playing) pauseMusic();
      else resumeOrPlay();
    });
    document.getElementById('gp-stop').addEventListener('click', stopMusic);
    document.getElementById('gp-list-btn').addEventListener('click', function() {
      var list = document.getElementById('gp-playlist');
      if (!list) return;
      list.hidden = !list.hidden;
    });
    document.getElementById('gp-collapse').addEventListener('click', function() {
      musicPlayer.collapsed = !musicPlayer.collapsed;
      if (musicPlayer.collapsed) {
        var list = document.getElementById('gp-playlist');
        if (list) list.hidden = true;
      }
      updatePlayerChrome();
    });
    document.getElementById('gp-cover').addEventListener('click', function() {
      if (!musicPlayer.collapsed) return;
      musicPlayer.collapsed = false;
      updatePlayerChrome();
    });
    document.getElementById('gp-cover').addEventListener('keydown', function(e) {
      if (!musicPlayer.collapsed) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      musicPlayer.collapsed = false;
      updatePlayerChrome();
    });

    var seek = document.getElementById('gp-seek');
    seek.addEventListener('pointerdown', function() {
      musicPlayer.seeking = true;
    });
    seek.addEventListener('pointerup', function() {
      musicPlayer.seeking = false;
      seekTo(parseFloat(seek.value));
    });
    seek.addEventListener('change', function() {
      musicPlayer.seeking = false;
      seekTo(parseFloat(seek.value));
    });
    seek.addEventListener('input', function() {
      var cur = document.getElementById('gp-time-cur');
      if (cur) cur.textContent = formatTime(parseFloat(seek.value) || 0);
    });
  }

  function compactEmbedUrl(track) {
    if (!track || !track.embedUrl) return '';
    if (track.platform === 'spotify') {
      var u = track.embedUrl.replace(/([?&])height=\d+/i, '');
      return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'theme=0';
    }
    if (track.platform === 'netease') {
      return track.embedUrl.replace(/height=\d+/i, 'height=66');
    }
    return track.embedUrl;
  }

  function setCoverEl(el, coverUrl) {
    if (!el) return;
    if (coverUrl) {
      el.style.backgroundImage = 'url("' + coverUrl.replace(/"/g, '\\"') + '")';
      el.classList.add('has-cover');
    } else {
      el.style.backgroundImage = '';
      el.classList.remove('has-cover');
    }
  }

  function clearEngine() {
    var wrap = document.getElementById('gp-embed');
    if (wrap) wrap.innerHTML = '';
    musicPlayer.engine = null;
    resetProgressUi(0, 0, false);
  }

  function resetProgressUi(current, duration, seekable) {
    var seek = document.getElementById('gp-seek');
    var curEl = document.getElementById('gp-time-cur');
    var durEl = document.getElementById('gp-time-dur');
    var progress = document.getElementById('gp-progress');
    if (curEl) curEl.textContent = formatTime(current);
    if (durEl) durEl.textContent = formatTime(duration);
    if (seek) {
      seek.max = duration > 0 ? String(duration) : '0';
      if (!musicPlayer.seeking) seek.value = String(current || 0);
      seek.disabled = !seekable;
    }
    if (progress) {
      progress.classList.toggle('gp-progress-disabled', !seekable);
      progress.title = seekable ? '' : '当前曲目通过平台嵌入播放，无法读取进度';
    }
  }

  function updateProgressFromAudio(audio) {
    if (!audio || musicPlayer.seeking) return;
    var duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    var track = musicPlayer.playlist[musicPlayer.index];
    if (!duration && track && track.durationMs) {
      duration = track.durationMs / 1000;
    }
    resetProgressUi(audio.currentTime || 0, duration, true);
  }

  function seekTo(seconds) {
    if (musicPlayer.engine !== 'audio') return;
    var audio = document.getElementById('gp-audio');
    if (!audio || !Number.isFinite(seconds)) return;
    try {
      audio.currentTime = seconds;
    } catch (e) { /* ignore */ }
    updateProgressFromAudio(audio);
  }

  function updatePlayerChrome() {
    var root = document.getElementById('global-player');
    var titleEl = document.getElementById('gp-title');
    var subEl = document.getElementById('gp-sub');
    var coverEl = document.getElementById('gp-cover');
    var toggleBtn = document.getElementById('gp-toggle');
    var collapseBtn = document.getElementById('gp-collapse');
    var listEl = document.getElementById('gp-playlist');
    if (!root || !titleEl) return;

    if (!musicPlayer.playlist.length) {
      root.hidden = true;
      titleEl.textContent = '未在播放';
      if (subEl) subEl.textContent = '';
      setCoverEl(coverEl, '');
      resetProgressUi(0, 0, false);
      return;
    }

    root.hidden = false;
    root.classList.toggle('gp-collapsed', musicPlayer.collapsed);
    root.classList.toggle('gp-playing', musicPlayer.playing);
    var track = musicPlayer.playlist[musicPlayer.index];
    titleEl.textContent = track.title || '未知曲目';
    if (subEl) {
      var bits = [];
      if (track.artist) bits.push(track.artist);
      bits.push(platformLabel(track));
      bits.push((musicPlayer.index + 1) + '/' + musicPlayer.playlist.length);
      if (musicPlayer.sourceTitle) bits.push(musicPlayer.sourceTitle);
      subEl.textContent = bits.filter(Boolean).join(' · ');
    }
    setCoverEl(coverEl, track.coverUrl || '');
    if (coverEl) {
      coverEl.setAttribute('aria-hidden', musicPlayer.collapsed ? 'false' : 'true');
      coverEl.setAttribute('role', musicPlayer.collapsed ? 'button' : 'img');
      coverEl.setAttribute('aria-label', musicPlayer.collapsed ? '展开播放器' : '当前播放封面');
      coverEl.setAttribute('tabindex', musicPlayer.collapsed ? '0' : '-1');
      coverEl.title = musicPlayer.collapsed ? '展开播放器' : '';
    }
    if (toggleBtn) toggleBtn.textContent = musicPlayer.playing ? '❚❚' : '▶';
    if (collapseBtn) {
      collapseBtn.textContent = musicPlayer.collapsed ? '⌃' : '⌄';
      collapseBtn.title = musicPlayer.collapsed ? '展开播放器' : '收起播放器';
      collapseBtn.setAttribute('aria-label', musicPlayer.collapsed ? '展开播放器' : '收起播放器');
      collapseBtn.setAttribute('aria-expanded', musicPlayer.collapsed ? 'false' : 'true');
    }

    if (musicPlayer.engine !== 'audio') {
      var dur = track.durationMs ? track.durationMs / 1000 : 0;
      resetProgressUi(0, dur, false);
    }

    if (listEl) {
      listEl.innerHTML = musicPlayer.playlist.map(function(t, i) {
        var active = i === musicPlayer.index ? ' gp-playlist-active' : '';
        var cover = t.coverUrl
          ? '<span class="gp-playlist-cover" style="background-image:url(\'' +
            escapeHtml(t.coverUrl) + '\')"></span>'
          : '<span class="gp-playlist-cover"></span>';
        var artist = t.artist
          ? '<span class="gp-playlist-artist">' + escapeHtml(t.artist) + '</span>'
          : '';
        return '<li class="gp-playlist-item' + active + '" data-index="' + i + '">' +
          cover +
          '<span class="gp-playlist-text">' +
            '<span class="gp-playlist-title">' + escapeHtml(t.title || '未知曲目') + '</span>' +
            artist +
          '</span>' +
          '</li>';
      }).join('');
      listEl.querySelectorAll('.gp-playlist-item').forEach(function(item) {
        item.addEventListener('click', function() {
          playAt(parseInt(item.getAttribute('data-index'), 10));
        });
      });
    }
  }

  function mountEmbed(track) {
    var wrap = document.getElementById('gp-embed');
    if (!wrap) return;
    wrap.innerHTML = '';
    musicPlayer.engine = 'embed';
    if (!track) return;

    var iframe = document.createElement('iframe');
    iframe.id = 'gp-frame';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allow', 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture');
    iframe.setAttribute('tabindex', '-1');
    iframe.title = 'audio';
    iframe.src = compactEmbedUrl(track);
    wrap.appendChild(iframe);

    var dur = track.durationMs ? track.durationMs / 1000 : 0;
    resetProgressUi(0, dur, false);
  }

  function mountAudio(track) {
    var wrap = document.getElementById('gp-embed');
    if (!wrap || !track || !track.audioUrl) return false;
    wrap.innerHTML = '';

    var audio = document.createElement('audio');
    audio.id = 'gp-audio';
    audio.preload = 'metadata';
    audio.src = track.audioUrl;
    audio.setAttribute('playsinline', '');

    audio.addEventListener('timeupdate', function() {
      updateProgressFromAudio(audio);
    });
    audio.addEventListener('loadedmetadata', function() {
      updateProgressFromAudio(audio);
    });
    audio.addEventListener('durationchange', function() {
      updateProgressFromAudio(audio);
    });
    audio.addEventListener('ended', function() {
      if (musicPlayer.playlist.length > 1) {
        var i = (musicPlayer.index + 1) % musicPlayer.playlist.length;
        playAt(i);
      } else {
        musicPlayer.playing = false;
        updatePlayerChrome();
      }
    });
    audio.addEventListener('error', function() {
      // Free-track URL unavailable (VIP / region) → fall back to platform embed.
      mountEmbed(track);
      updatePlayerChrome();
    });

    wrap.appendChild(audio);
    musicPlayer.engine = 'audio';

    var knownDur = track.durationMs ? track.durationMs / 1000 : 0;
    resetProgressUi(0, knownDur, true);

    var playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(function() {
        mountEmbed(track);
        updatePlayerChrome();
      });
    }
    return true;
  }

  function playAt(index) {
    if (!musicPlayer.playlist.length) return;
    if (index < 0 || index >= musicPlayer.playlist.length) return;
    musicPlayer.index = index;
    musicPlayer.playing = true;
    var track = musicPlayer.playlist[index];
    if (track.audioUrl) {
      mountAudio(track);
    } else {
      mountEmbed(track);
    }
    updatePlayerChrome();
  }

  function pauseMusic() {
    musicPlayer.playing = false;
    if (musicPlayer.engine === 'audio') {
      var audio = document.getElementById('gp-audio');
      if (audio) audio.pause();
    } else {
      // Cross-origin embeds cannot be paused via API — unload to stop audio.
      clearEngine();
    }
    updatePlayerChrome();
  }

  function resumeOrPlay() {
    if (!musicPlayer.playlist.length) return;
    if (musicPlayer.engine === 'audio') {
      var audio = document.getElementById('gp-audio');
      if (audio) {
        musicPlayer.playing = true;
        audio.play();
        updatePlayerChrome();
        return;
      }
    }
    playAt(musicPlayer.index);
  }

  function stopMusic() {
    musicPlayer.playlist = [];
    musicPlayer.index = 0;
    musicPlayer.sourceTitle = '';
    musicPlayer.playing = false;
    clearEngine();
    var list = document.getElementById('gp-playlist');
    if (list) {
      list.innerHTML = '';
      list.hidden = true;
    }
    updatePlayerChrome();
  }

  /**
   * Load a card's tracks as the active playlist.
   * Switching cards does NOT call this — music keeps playing until user replaces the list.
   */
  function loadCardPlaylist(event, startIndex) {
    if (!event || !event.tracks || !event.tracks.length) return;
    startIndex = startIndex || 0;
    musicPlayer.playlist = event.tracks.map(function(t) {
      return {
        platform: t.platform,
        id: t.id,
        title: trackDisplayTitle(t, event),
        artist: t.artist || '',
        coverUrl: t.coverUrl || '',
        durationMs: t.durationMs || 0,
        audioUrl: t.audioUrl || '',
        embedUrl: t.embedUrl,
      };
    });
    musicPlayer.sourceTitle = event.title || '';
    playAt(startIndex);
  }

  /**
   * Hydrate parser-emitted .ec-music-play placeholders with cover / title / artist.
   * These replace music:: [name](url) — never render as markdown links.
   */
  function hydrateMusicButtons(container, event) {
    if (!container) return;
    var buttons = container.querySelectorAll('.ec-music-play');
    if (!buttons.length && event.tracks && event.tracks.length) {
      // Legacy pages with tracks but no markers — insert at top of content.
      var wrap = document.createElement('div');
      wrap.className = 'ec-music-plays';
      event.tracks.forEach(function(_, i) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ec-music-play';
        btn.setAttribute('data-track-index', String(i));
        wrap.appendChild(btn);
      });
      container.insertBefore(wrap, container.firstChild);
      buttons = container.querySelectorAll('.ec-music-play');
    }

    buttons.forEach(function(btn) {
      var i = parseInt(btn.getAttribute('data-track-index'), 10);
      var t = event.tracks && event.tracks[i];
      if (!t) {
        btn.remove();
        return;
      }
      var title = trackDisplayTitle(t, event);
      var cover = t.coverUrl
        ? '<span class="ec-music-cover" style="background-image:url(\'' + escapeHtml(t.coverUrl) + '\')"></span>'
        : '<span class="ec-music-cover"></span>';
      var artist = t.artist
        ? '<span class="ec-music-artist">' + escapeHtml(t.artist) + '</span>'
        : '';
      btn.type = 'button';
      btn.innerHTML =
        cover +
        '<span class="ec-music-icon" aria-hidden="true">▶</span>' +
        '<span class="ec-music-text">' +
          '<span class="ec-music-title">' + escapeHtml(title) + '</span>' +
          artist +
        '</span>';
      btn.addEventListener('click', function() {
        loadCardPlaylist(event, i);
      });
    });
  }

  var currentEventIndex = -1;
  var allEvents = [];
  var historyStack = [];
  var isRandomMode = false;
  var cardSource = null;
  var currentDayEvents = null;
  var currentDayDate = null;

  var modal = document.getElementById('card-modal');
  var cardDate = document.getElementById('card-date');
  var cardTitle = document.getElementById('card-title');
  var cardContent = document.getElementById('card-content');
  var cardMedia = document.getElementById('card-media');
  var cardTags = document.getElementById('card-tags');
  var cardLinks = document.getElementById('card-links');
  var randomBtn = document.getElementById('btn-random');

  function closeCard() {
    if (modal) modal.classList.remove('active');
    currentEventIndex = -1;
    historyStack = [];
    isRandomMode = false;
    cardSource = null;
  }

  function renderCard(event) {
    if (!cardDate || !cardTitle || !cardContent) return;

    cardDate.textContent = event.date;
    cardTitle.textContent = event.title;

    var randomBtn = document.getElementById('btn-random');
    if (randomBtn) {
      randomBtn.style.display = '';
      if (isRandomMode) {
        randomBtn.textContent = '→ 下一站';
      } else {
        randomBtn.textContent = '← 返回';
      }
    }
    var reselectBtn = document.getElementById('btn-reselect');
    if (reselectBtn) reselectBtn.style.display = 'none';

    // Render inline content. Images already have correct processed paths inside
    // contentHtml, so we keep them in place to preserve the document order.
    var rawContent = event.contentHtml || '<p>No content</p>';
    // Adjust image paths for modal context. contentHtml is stored with paths
    // relative to event pages (events/*.html), which use ../assets/. The modal
    // is rendered from index.html at dist root, so we need assets/.
    rawContent = rawContent.replace(/\.\.\/assets\//g, 'assets/');

    // Prefer preview derivatives in the modal (800px) over thumbnails (200px),
    // otherwise width:100% CSS upscales soft 200px thumbs.
    rawContent = rawContent.replace(/<img\b[^>]*>/gi, function(tag) {
      var preview = tag.match(/\bdata-preview="([^"]+)"/i);
      if (!preview) return tag;
      return tag.replace(/\bsrc="[^"]*"/i, 'src="' + preview[1] + '"');
    });

    cardContent.innerHTML = rawContent;

    // Recreate non-music iframes as live elements (YouTube etc.).
    // Music iframes are stripped at build time and played via the global player.
    cardContent.querySelectorAll('iframe').forEach(function(srcIframe) {
      var liveIframe = document.createElement('iframe');
      for (var i = 0; i < srcIframe.attributes.length; i++) {
        liveIframe.setAttribute(srcIframe.attributes[i].name, srcIframe.attributes[i].value);
      }
      srcIframe.parentNode.replaceChild(liveIframe, srcIframe);
    });

    hydrateMusicButtons(cardContent, event);

    if (cardMedia) {
      // Only append videos here; images are already rendered inline in contentHtml.
      var mediaHtml = '';
      event.media.forEach(function(m) {
        if (m.type === 'video' && m.thumbnailPath) {
          mediaHtml += '<video controls preload="metadata"><source src="' + escapeHtml(m.thumbnailPath) + '" type="video/mp4"></video>';
        }
      });
      cardMedia.innerHTML = mediaHtml;
      cardMedia.style.display = mediaHtml ? 'flex' : 'none';
    }

    if (cardTags) {
      if (event.tags && event.tags.length > 0) {
        cardTags.innerHTML = event.tags.map(function(t) {
          return '<span class="card-tag">' + t + '</span>';
        }).join('');
        cardTags.style.display = 'flex';
      } else {
        cardTags.innerHTML = '';
        cardTags.style.display = 'none';
      }
    }

    if (cardLinks) {
      if (event.links && event.links.length > 0) {
        cardLinks.innerHTML = event.links.map(function(l) {
          return '<a href="#" data-link="' + escapeHtml(l) + '" class="card-link">' + escapeHtml(l) + '</a>';
        }).join('');
        cardLinks.style.display = 'block';
      } else {
        cardLinks.innerHTML = '';
        cardLinks.style.display = 'none';
      }
    }
  }

  function openCard(index, startRandomMode) {
    if (index < 0 || index >= allEvents.length) return;
    if (startRandomMode) {
      isRandomMode = true;
      historyStack = [];
    } else if (currentEventIndex >= 0) {
      historyStack.push(currentEventIndex);
    }
    currentEventIndex = index;
    var event = allEvents[index];
    unlock(event.id);
    renderCard(event);
    if (modal) modal.classList.add('active');
  }

  function reopenDatePicker() {
    currentEventIndex = -1;
    if (modal) modal.classList.remove('active');
    var dateModal = document.getElementById('date-modal');
    if (dateModal) dateModal.classList.add('active');
  }

  function navigateBack() {
    if (historyStack.length > 0) {
      var prevState = historyStack.pop();
      if (prevState && typeof prevState === 'object') {
        if (prevState.type === 'day-selector') {
          showDaySelector(prevState.date, prevState.events);
          return;
        }
        if (prevState.type === 'date-picker') {
          reopenDatePicker();
          return;
        }
      }
      // Numeric index: previous event card
      currentEventIndex = prevState;
      var event = allEvents[prevState];
      if (event) renderCard(event);
      return;
    }

    // Stack empty: restore entry source before closeCard clears it
    var source = cardSource;
    closeCard();
    if (source === 'date-picker') {
      var dateModal = document.getElementById('date-modal');
      if (dateModal) dateModal.classList.add('active');
    }
  }

  function randomCard() {
    if (allEvents.length === 0) return;
    if (isRandomMode) {
      var randomIndex = Math.floor(Math.random() * allEvents.length);
      while (randomIndex === currentEventIndex && allEvents.length > 1) {
        randomIndex = Math.floor(Math.random() * allEvents.length);
      }
      openCard(randomIndex);
    } else {
      navigateBack();
    }
  }

  ensureGlobalPlayer();

  var launchBtn = document.getElementById('launch-btn');
  if (launchBtn) {
    allEvents = getEventData();

    var totalEl = document.getElementById('total-events');
    if (totalEl) totalEl.textContent = allEvents.length;

    var unlocked = getUnlocked();
    var validEventIds = new Set(allEvents.map(function(e) { return e.id; }));
    var unlockedCount = Object.keys(unlocked).filter(function(id) { return validEventIds.has(id); }).length;
    var unlockedEl = document.getElementById('unlocked-count');
    if (unlockedEl) unlockedEl.textContent = unlockedCount;

    launchBtn.addEventListener('click', function() {
      if (allEvents.length === 0) {
        launchBtn.textContent = '暂无事件';
        return;
      }

      var lockedEvents = allEvents.filter(function(e) {
        return !isUnlocked(e.id);
      });

      var pool = lockedEvents.length > 0 ? lockedEvents : allEvents;
      var randomIndex = Math.floor(Math.random() * pool.length);
      var event = pool[randomIndex];
      var globalIndex = allEvents.findIndex(function(e) { return e.id === event.id; });

      historyStack = [];
      openCard(globalIndex, true);
    });

    var dateJumpBtn = document.getElementById('date-jump-btn');
    var dateModal = document.getElementById('date-modal');
    var dateClose = document.getElementById('date-close');
    var dateConfirm = document.getElementById('date-confirm');
    var datePicker = document.getElementById('date-picker');

    if (dateJumpBtn && dateModal) {
      dateJumpBtn.addEventListener('click', function() {
        if (datePicker) {
          var today = new Date();
          datePicker.value = today.toISOString().split('T')[0];
        }
        dateModal.classList.add('active');
      });
    }

    if (dateClose && dateModal) {
      dateClose.addEventListener('click', function() {
        dateModal.classList.remove('active');
      });
      dateModal.addEventListener('click', function(e) {
        if (e.target === dateModal) dateModal.classList.remove('active');
      });
    }

    // ── About modal ──────────────────────────────────────────────
    var aboutBtn = document.getElementById('about-btn');
    var aboutModal = document.getElementById('about-modal');
    var aboutClose = document.getElementById('about-close');
    if (aboutBtn && aboutModal) {
      aboutBtn.addEventListener('click', function() { aboutModal.classList.add('active'); });
    }
    if (aboutClose && aboutModal) {
      aboutClose.addEventListener('click', function() { aboutModal.classList.remove('active'); });
      aboutModal.addEventListener('click', function(e) {
        if (e.target === aboutModal) aboutModal.classList.remove('active');
      });
    }

    if (dateConfirm && datePicker) {
      dateConfirm.addEventListener('click', function() {
        var date = datePicker.value;
        if (!date) return;
        var dayEvents = allEvents.filter(function(e) { return e.hasValidDate && e.date === date; });
        dateModal.classList.remove('active');
        if (dayEvents.length === 0) {
          cardSource = 'date-picker';
          historyStack = [{ type: 'date-picker' }];
          showMemoryLocked(date);
        } else {
          isRandomMode = false;
          cardSource = 'date-picker';
          historyStack = [{ type: 'date-picker' }];
          showDaySelector(date, dayEvents);
        }
      });
    }
  }

  function showMemoryLocked(date) {
    if (!modal) return;
    currentEventIndex = -1;
    isRandomMode = false;
    cardDate.textContent = date;
    cardTitle.textContent = '记忆尚未解锁';
    cardContent.innerHTML = '<p style="text-align:center;color:var(--text-dim);padding:2rem 0;">这一天没有留下任何记录。</p>';
    if (cardMedia) { cardMedia.innerHTML = ''; cardMedia.style.display = 'none'; }
    if (cardTags) { cardTags.innerHTML = ''; cardTags.style.display = 'none'; }
    if (cardLinks) { cardLinks.innerHTML = ''; cardLinks.style.display = 'none'; }
    var randomBtn = document.getElementById('btn-random');
    // Keep 「返回」 so empty days also go back to the date picker via historyStack.
    if (randomBtn) {
      randomBtn.style.display = '';
      randomBtn.textContent = '← 返回';
    }
    var reselectBtn = document.getElementById('btn-reselect');
    if (reselectBtn) reselectBtn.style.display = 'none';
    modal.classList.add('active');
  }

  function showDaySelector(date, dayEvents) {
    if (!modal) return;
    // Reset so openCard won't push a stale event index when picking from the list.
    currentEventIndex = -1;
    isRandomMode = false;
    currentDayDate = date;
    currentDayEvents = dayEvents;
    cardDate.textContent = date;
    cardTitle.textContent = '选择记忆';
    var listHtml = dayEvents.map(function(e) {
      return '<div class="day-event-item" data-id="' + e.id + '">' +
        '<div class="day-event-title">' + escapeHtml(e.title) + '</div>' +
        (e.media && e.media.length > 0 ? '<div class="day-event-has-media">📷</div>' : '') +
        '</div>';
    }).join('');
    cardContent.innerHTML = '<div class="day-event-list">' + listHtml + '</div>';
    if (cardMedia) { cardMedia.innerHTML = ''; cardMedia.style.display = 'none'; }
    if (cardTags) { cardTags.innerHTML = ''; cardTags.style.display = 'none'; }
    if (cardLinks) { cardLinks.innerHTML = ''; cardLinks.style.display = 'none'; }
    var randomBtn = document.getElementById('btn-random');
    if (randomBtn) randomBtn.style.display = '';
    randomBtn.textContent = '← 返回';
    var reselectBtn = document.getElementById('btn-reselect');
    if (reselectBtn) reselectBtn.style.display = 'none';
    modal.classList.add('active');

    var items = document.querySelectorAll('.day-event-item');
    items.forEach(function(item) {
      item.addEventListener('click', function() {
        var id = this.getAttribute('data-id');
        var index = allEvents.findIndex(function(e) { return e.id === id; });
        if (index >= 0) {
          historyStack.push({ type: 'day-selector', date: date, events: dayEvents });
          cardSource = 'date-picker';
          openCard(index);
        }
      });
    });
  }

  if (modal) {
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeCard();
    });
  }

  var closeBtn = document.getElementById('card-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeCard);
  }

  document.addEventListener('click', function(e) {
    var link = e.target.closest('.card-link');
    if (link) {
      e.preventDefault();
      var linkTitle = link.getAttribute('data-link');
      var targetIndex = allEvents.findIndex(function(e) {
        return e.title === linkTitle || e.id.toLowerCase().indexOf(linkTitle.toLowerCase().replace(/\s+/g, '-')) >= 0;
      });
      if (targetIndex >= 0) {
        openCard(targetIndex);
      }
      return;
    }
    var tmLink = e.target.closest('.tm-link');
    if (tmLink) {
      e.preventDefault();
      var name = decodeURIComponent(tmLink.getAttribute('href').replace(/^#/, ''));
      var idx = allEvents.findIndex(function(e) { return e.title === name; });
      if (idx >= 0) {
        openCard(idx);
      }
    }
  });

  if (randomBtn) {
    randomBtn.addEventListener('click', randomCard);
  }

  var reselectBtn = document.getElementById('btn-reselect');
  if (reselectBtn) {
    reselectBtn.addEventListener('click', function() {
      closeCard();
      var dateModal = document.getElementById('date-modal');
      if (dateModal) dateModal.classList.add('active');
    });
  }

  document.addEventListener('keydown', function(e) {
    var aboutModal = document.getElementById('about-modal');
    if (aboutModal && aboutModal.classList.contains('active')) {
      if (e.key === 'Escape') aboutModal.classList.remove('active');
      return;
    }
    if (!modal || !modal.classList.contains('active')) return;
    if (e.key === 'Escape') closeCard();
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      randomCard();
    }
  });

  var archiveGrid = document.getElementById('archive-grid');
  if (archiveGrid) {
    ensureGlobalPlayer();
    var archiveEvents = [];
    var activeTag = null;

    archiveEvents = getEventData();
    allEvents = archiveEvents;
    
    var unlocked = getUnlocked();
    archiveEvents = archiveEvents.filter(function(e) { return e.id in unlocked; });
    archiveEvents.sort(function(a, b) { return b.date.localeCompare(a.date); });

    function renderTags() {
      var tagSet = {};
      archiveEvents.forEach(function(e) {
        if (e.tags) e.tags.forEach(function(t) { tagSet[t] = (tagSet[t] || 0) + 1; });
      });

      var container = document.getElementById('tag-filter');
      if (!container) return;

      var html = Object.keys(tagSet).sort().map(function(tag) {
        return '<span class="tag-chip" data-tag="' + tag + '">' + tag + ' (' + tagSet[tag] + ')</span>';
      }).join('');
      container.innerHTML = html;

      container.querySelectorAll('.tag-chip').forEach(function(chip) {
        chip.addEventListener('click', function() {
          var tag = chip.getAttribute('data-tag');
          if (activeTag === tag) {
            activeTag = null;
            chip.classList.remove('active');
          } else {
            activeTag = tag;
            container.querySelectorAll('.tag-chip').forEach(function(c) { c.classList.remove('active'); });
            chip.classList.add('active');
          }
          renderGrid();
        });
      });
    }

    function renderGrid(query) {
      query = query || '';
      var filtered = archiveEvents.filter(function(e) {
        var matchText = !query || e.title.toLowerCase().indexOf(query) >= 0;
        var matchTag = !activeTag || (e.tags && e.tags.indexOf(activeTag) >= 0);
        return matchText && matchTag;
      });

      if (filtered.length === 0) {
        archiveGrid.innerHTML = '<div class="archive-empty">没有找到匹配的事件。</div>';
        return;
      }

      archiveGrid.innerHTML = filtered.map(function(e) {
        var tagsHtml = e.tags ? e.tags.map(function(t) { return '#' + t; }).join(' ') : '';
        return '<div class="archive-card" data-id="' + e.id + '">' +
          '<div class="archive-card-date">' + e.date + '</div>' +
          '<div class="archive-card-title">' + e.title + '</div>' +
          '<div class="archive-card-tags">' + tagsHtml + '</div>' +
        '</div>';
      }).join('');

      archiveGrid.querySelectorAll('.archive-card').forEach(function(card) {
      card.addEventListener('click', function() {
        var id = card.getAttribute('data-id');
        var index = allEvents.findIndex(function(e) { return e.id === id; });
        if (index >= 0) {
          historyStack = [];
          cardSource = 'archive';
          openCard(index);
        }
      });
    });
    }

    renderTags();
    renderGrid();

    var search = document.getElementById('archive-search');
    if (search) {
      search.addEventListener('input', function() {
        renderGrid(search.value.toLowerCase());
      });
    }
  }
})();
