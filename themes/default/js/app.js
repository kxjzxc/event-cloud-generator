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

  function getEventIndex() {
    var el = document.getElementById('event-index');
    if (!el) return [];
    try { return JSON.parse(el.textContent); }
    catch(e) { console.error('Failed to parse event index:', e); return []; }
  }

  var launchBtn = document.getElementById('launch-btn');
  if (launchBtn) {
    var index = getEventIndex();

    var totalEl = document.getElementById('total-events');
    if (totalEl) totalEl.textContent = index.length;

    var unlocked = getUnlocked();
    var unlockedCount = Object.keys(unlocked).length;
    var unlockedEl = document.getElementById('unlocked-count');
    if (unlockedEl) unlockedEl.textContent = unlockedCount;

    launchBtn.addEventListener('click', function() {
      if (index.length === 0) {
        launchBtn.querySelector('span').textContent = '暂无事件';
        return;
      }
      launchBtn.querySelector('span').textContent = '探索中...';
      launchBtn.disabled = true;

      var lockedEvents = index.filter(function(e) {
        return !isUnlocked(e.id);
      });

      var pool = lockedEvents.length > 0 ? lockedEvents : index;
      var random = pool[Math.floor(Math.random() * pool.length)];

      unlock(random.id);
      window.location.href = 'events/' + random.id + '.html';
    });
  }

  var eventPage = document.querySelector('.event-page');
  if (eventPage) {
    var eventId = eventPage.getAttribute('data-event-id');
    if (eventId) unlock(eventId);
  }

  var travelBtn = document.getElementById('travel-again');
  if (travelBtn) {
    travelBtn.addEventListener('click', function(e) {
      e.preventDefault();
      var index = getEventIndex();
      if (index.length === 0) return;

      var currentId = eventPage ? eventPage.getAttribute('data-event-id') : '';
      var unlocked = getUnlocked();
      var lockedEvents = index.filter(function(e) {
        return !(e.id in unlocked) && e.id !== currentId;
      });
      var pool = lockedEvents.length > 0 ? lockedEvents : index.filter(function(e) { return e.id !== currentId; });
      if (pool.length === 0) return;
      var random = pool[Math.floor(Math.random() * pool.length)];
      unlock(random.id);
      window.location.href = random.id + '.html';
    });
  }

  var modal = document.getElementById('image-modal');
  var modalImg = document.getElementById('modal-img');
  if (modal) {
    document.querySelectorAll('.event-media img, .event-content img').forEach(function(img) {
      img.addEventListener('click', function() {
        var previewSrc = img.getAttribute('data-preview') || img.src;
        modalImg.src = previewSrc;
        modal.classList.add('active');
      });
    });
    modal.addEventListener('click', function() {
      modal.classList.remove('active');
    });
  }

  var archiveGrid = document.getElementById('archive-grid');
  if (archiveGrid) {
    var allEvents = [];
    var activeTag = null;

    var index = getEventIndex();
    var unlocked = getUnlocked();
    allEvents = index.filter(function(e) { return e.id in unlocked; });

    allEvents.sort(function(a, b) { return b.date.localeCompare(a.date); });

    renderTags();
    renderGrid();

    var search = document.getElementById('archive-search');
    if (search) {
      search.addEventListener('input', function() {
        renderGrid(search.value.toLowerCase());
      });
    }

    function renderTags() {
      var tagSet = {};
      allEvents.forEach(function(e) {
        e.tags.forEach(function(t) { tagSet[t] = (tagSet[t] || 0) + 1; });
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
      var filtered = allEvents.filter(function(e) {
        var matchText = !query || e.title.toLowerCase().indexOf(query) >= 0;
        var matchTag = !activeTag || e.tags.indexOf(activeTag) >= 0;
        return matchText && matchTag;
      });

      if (filtered.length === 0) {
        archiveGrid.innerHTML = '<div class="archive-empty">没有找到匹配的事件。<br>先去探索事件云发现更多吧。</div>';
        return;
      }

      archiveGrid.innerHTML = filtered.map(function(e) {
        var tagsHtml = e.tags.map(function(t) { return '#' + t; }).join(' ');
        return '<a class="archive-card" href="events/' + e.id + '.html">' +
          '<div class="archive-card-date">' + e.date + '</div>' +
          '<div class="archive-card-title">' + e.title + '</div>' +
          '<div class="archive-card-tags">' + tagsHtml + '</div>' +
        '</a>';
      }).join('');
    }
  }
})();