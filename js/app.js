import {
  openDatabase,
  getAll,
  getOne,
  putOne,
  putMany,
  deleteOne,
  exportDatabase,
  importDatabase
} from './db.js';
import { LIBRARY_WORDS } from './library.js';

const APP_VERSION = '0.2.3';
const DAY = 86_400_000;

const seedWords = [
  {
    id: crypto.randomUUID(), term: 'available', translation: 'доступный; имеющийся',
    pronunciation: 'эвэ́йлэбл', transcription: '/əˈveɪləbl/', partOfSpeech: 'adjective',
    example: 'The cabin is available.', exampleTranslation: 'Каюта свободна.',
    category: 'Судно', status: 'learning', favorite: true, important: true
  },
  {
    id: crypto.randomUUID(), term: 'supplies', translation: 'припасы; снабжение',
    pronunciation: 'сэпла́йз', transcription: '/səˈplaɪz/', partOfSpeech: 'noun',
    example: 'We are waiting for supplies.', exampleTranslation: 'Мы ждём снабжение.',
    category: 'Судно', status: 'new', favorite: false, important: true
  },
  {
    id: crypto.randomUUID(), term: 'departure', translation: 'отправление; вылет',
    pronunciation: 'дипа́рчер', transcription: '/dɪˈpɑːrtʃər/', partOfSpeech: 'noun',
    example: 'My departure is at 4:15 p.m.', exampleTranslation: 'Мой вылет в 16:15.',
    category: 'Аэропорт', status: 'learning', favorite: true, important: false
  },
  {
    id: crypto.randomUUID(), term: 'crew', translation: 'экипаж',
    pronunciation: 'кру', transcription: '/kruː/', partOfSpeech: 'noun',
    example: 'The crew is ready.', exampleTranslation: 'Экипаж готов.',
    category: 'Судно', status: 'difficult', favorite: false, important: true
  },
  {
    id: crypto.randomUUID(), term: 'galley', translation: 'камбуз',
    pronunciation: 'гэ́ли', transcription: '/ˈɡæli/', partOfSpeech: 'noun',
    example: 'The galley is clean.', exampleTranslation: 'Камбуз чистый.',
    category: 'Камбуз', status: 'new', favorite: false, important: false
  }
].map((word, index) => ({
  ...word,
  createdAt: new Date(Date.now() - index * DAY).toISOString(),
  updatedAt: new Date().toISOString(),
  nextReviewAt: new Date(Date.now() - index * 60_000).toISOString(),
  intervalDays: 0,
  correctCount: 0,
  wrongCount: 0,
  lastReviewedAt: null,
  syncState: 'local'
}));

const defaultProfile = {
  id: 'current',
  localUserId: crypto.randomUUID(),
  displayName: 'Гость',
  email: '',
  accountStatus: 'guest',
  totalXp: 0,
  streak: 0,
  lastActiveDate: null,
  createdAt: new Date().toISOString(),
  syncState: 'local'
};

const defaultSettings = {
  id: 'main',
  newWordsPerDay: 10,
  sessionLength: 12,
  voiceLang: 'en-US',
  speechRate: 0.85,
  autoPlay: false,
  theme: 'light',
  syncEnabled: false,
  apiBaseUrl: ''
};

const state = {
  route: 'today',
  words: [],
  sessions: [],
  profile: { ...defaultProfile },
  settings: { ...defaultSettings },
  search: '',
  category: 'Все',
  librarySearch: '',
  libraryLevel: 'Все',
  libraryTopic: 'Все',
  session: null,
  deferredInstallPrompt: null,
};

const view = document.querySelector('#view');
const modalRoot = document.querySelector('#modalRoot');
const toast = document.querySelector('#toast');
const connectionBar = document.querySelector('#connectionBar');

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function uid() {
  return crypto.randomUUID();
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function rankForLevel(level) {
  if (level <= 5) return { name: 'Новичок', icon: '🌱' };
  if (level <= 10) return { name: 'Исследователь', icon: '🧭' };
  if (level <= 15) return { name: 'Практик', icon: '📘' };
  if (level <= 20) return { name: 'Уверенный', icon: '🛡️' };
  if (level <= 25) return { name: 'Продвинутый', icon: '⭐' };
  return { name: 'Мастер слов', icon: '🏅' };
}

function xpRequiredForLevel(level) {
  return 100 + 25 * (level - 1);
}

function levelData(totalXp) {
  let level = 1;
  let remaining = Math.max(0, totalXp);
  while (level < 100 && remaining >= xpRequiredForLevel(level)) {
    remaining -= xpRequiredForLevel(level);
    level += 1;
  }
  const required = xpRequiredForLevel(level);
  return {
    level,
    currentXp: remaining,
    requiredXp: required,
    percent: Math.min(100, Math.round((remaining / required) * 100)),
    rank: rankForLevel(level)
  };
}

function normalizeWord(word) {
  return {
    intervalDays: 0,
    correctCount: 0,
    wrongCount: 0,
    favorite: false,
    important: false,
    status: 'new',
    syncState: 'local',
    ...word
  };
}

async function bootstrap() {
  await openDatabase();

  const [storedWords, storedSessions, storedProfile, storedSettings] = await Promise.all([
    getAll('words'),
    getAll('sessions'),
    getOne('profile', 'current'),
    getOne('settings', 'main')
  ]);

  if (!storedWords.length) {
    await putMany('words', seedWords);
    state.words = seedWords.map(normalizeWord);
  } else {
    state.words = storedWords.map(normalizeWord);
  }

  state.sessions = storedSessions || [];
  state.profile = storedProfile || { ...defaultProfile };
  state.settings = { ...defaultSettings, ...(storedSettings || {}) };

  if (!storedProfile) await putOne('profile', state.profile);
  if (!storedSettings) await putOne('settings', state.settings);

  bindEvents();
  updateConnectionState();
  updateHeader();
  render();
  registerServiceWorker();
}

function bindEvents() {
  document.addEventListener('click', handleClick);
  document.addEventListener('input', handleInput);
  document.addEventListener('change', handleChange);
  window.addEventListener('online', updateConnectionState);
  window.addEventListener('offline', updateConnectionState);

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
  });
}

async function handleClick(event) {
  const routeButton = event.target.closest('[data-route]');
  if (routeButton) {
    navigate(routeButton.dataset.route);
    return;
  }

  const actionElement = event.target.closest('[data-action]');
  if (!actionElement) return;

  const action = actionElement.dataset.action;
  const id = actionElement.dataset.id;

  switch (action) {
    case 'go-today': navigate('today'); break;
    case 'start-session': await startSession(); break;
    case 'reveal-answer': revealAnswer(); break;
    case 'rate-answer': await rateAnswer(actionElement.dataset.rating); break;
    case 'speak': speak(actionElement.dataset.text || ''); break;
    case 'add-word': openWordModal(); break;
    case 'edit-word': openWordModal(state.words.find((word) => word.id === id)); break;
    case 'save-word': await saveWordFromForm(); break;
    case 'delete-word': await deleteWord(id); break;
    case 'toggle-favorite': await toggleFavorite(id); break;
    case 'close-modal': closeModal(); break;
    case 'open-level': openLevelModal(); break;
    case 'set-category': state.category = actionElement.dataset.category; renderDictionary(); break;
    case 'open-library': navigate('library'); break;
    case 'go-dictionary': navigate('dictionary'); break;
    case 'set-library-level': state.libraryLevel = actionElement.dataset.level; renderLibrary(); break;
    case 'set-library-topic': state.libraryTopic = actionElement.dataset.topic; renderLibrary(); break;
    case 'add-library-word': await addLibraryWord(id); break;
    case 'add-library-pack': await addLibraryPack(); break;
    case 'export-data': await exportData(); break;
    case 'trigger-import': document.querySelector('#importFile')?.click(); break;
    case 'install-app': await installApp(); break;
    case 'account-info': openAccountModal(); break;
    case 'finish-session': finishSessionView(); break;
    case 'reset-demo': await resetDemoProgress(); break;
    default: break;
  }
}

function handleInput(event) {
  if (event.target.matches('#dictionarySearch')) {
    state.search = event.target.value;
    renderDictionary();
  }
  if (event.target.matches('#librarySearch')) {
    state.librarySearch = event.target.value;
    renderLibrary();
  }
}

async function handleChange(event) {
  if (event.target.matches('[data-setting]')) {
    const key = event.target.dataset.setting;
    const value = event.target.type === 'checkbox'
      ? event.target.checked
      : event.target.type === 'number' || event.target.tagName === 'SELECT' && key !== 'voiceLang'
        ? Number(event.target.value)
        : event.target.value;
    state.settings[key] = value;
    await putOne('settings', state.settings);
    showToast('Настройки сохранены');
    if (key === 'theme') document.documentElement.dataset.theme = value;
  }

  if (event.target.matches('#importFile') && event.target.files?.[0]) {
    await importData(event.target.files[0]);
    event.target.value = '';
  }
}

function navigate(route) {
  state.route = route;
  const activeRoute = route === 'library' ? 'dictionary' : route;
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.route === activeRoute);
  });
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function render() {
  switch (state.route) {
    case 'dictionary': renderDictionary(); break;
    case 'library': renderLibrary(); break;
    case 'study': renderStudy(); break;
    case 'progress': renderProgress(); break;
    case 'profile': renderProfile(); break;
    default: renderToday(); break;
  }
  updateHeader();
}

function dueWords() {
  const now = Date.now();
  return state.words.filter((word) => new Date(word.nextReviewAt || 0).getTime() <= now);
}

function newWords() {
  return state.words.filter((word) => word.status === 'new');
}

function learnedWords() {
  return state.words.filter((word) => word.status === 'learned');
}

function updateHeader() {
  const data = levelData(state.profile.totalXp || 0);
  document.querySelector('#levelNumber').textContent = data.level;
  document.querySelector('#rankName').textContent = `${data.rank.icon} ${data.rank.name}`;
  document.querySelector('#levelXp').textContent = `${data.currentXp} / ${data.requiredXp} XP`;
  document.querySelector('.level-ring').style.setProperty('--level-progress', `${data.percent * 3.6}deg`);
}

function renderToday() {
  const due = dueWords().length;
  const fresh = newWords().length;
  const total = state.words.length;
  const level = levelData(state.profile.totalXp || 0);
  const todaySessions = state.sessions.filter((session) => session.completedAt?.startsWith(todayKey()));
  const todayReviewed = todaySessions.reduce((sum, session) => sum + (session.reviewed || 0), 0);
  const weeklyGoal = Math.min(100, Math.round((sessionsLastDays(7).length / 5) * 100));

  view.innerHTML = `
    <section class="hero-card">
      <div>
        <span class="eyebrow">Сегодня</span>
        <h1>Привет, ${escapeHtml(state.profile.displayName)}! 👋</h1>
        <p>Небольшое занятие сегодня — заметно больше уверенности завтра.</p>
      </div>
      <div class="hero-illustration" aria-hidden="true"><span>ABC</span><i>✦</i></div>
    </section>

    <section class="level-card">
      <div class="level-medallion">${level.rank.icon}<strong>${level.level}</strong></div>
      <div class="grow">
        <div class="section-heading compact"><div><span class="eyebrow">Ваш уровень</span><h2>${level.rank.name}</h2></div><strong>${level.percent}%</strong></div>
        <div class="progress-track"><span style="width:${level.percent}%"></span></div>
        <small>До уровня ${level.level + 1}: ${level.requiredXp - level.currentXp} XP</small>
      </div>
    </section>

    <section class="stats-grid">
      ${metricCard('↻', 'Повторить', due, 'слов ожидают', 'blue')}
      ${metricCard('+', 'Новые слова', fresh, 'доступно', 'teal')}
      ${metricCard('🔥', 'Серия дней', state.profile.streak || 0, 'дней подряд', 'yellow')}
      ${metricCard('✓', 'Сегодня', todayReviewed, 'повторено', 'violet')}
    </section>

    <button class="primary-cta" type="button" data-action="start-session">
      <span><small>${due || fresh ? 'Готово к повторению' : 'Свободная практика'}</small><strong>Начать занятие</strong></span>
      <span class="cta-arrow">→</span>
    </button>

    <section class="panel">
      <div class="section-heading"><div><span class="eyebrow">На этой неделе</span><h2>Учебный ритм</h2></div><strong>${weeklyGoal}%</strong></div>
      <div class="progress-track large"><span style="width:${weeklyGoal}%"></span></div>
      <div class="mini-summary"><span><strong>${sessionsLastDays(7).length}</strong><small>занятий</small></span><span><strong>${total}</strong><small>слов и фраз</small></span><span><strong>${learnedWords().length}</strong><small>усвоено</small></span></div>
    </section>

    <section class="phrase-card">
      <span class="quote-mark">“</span>
      <div><span class="eyebrow">Фраза дня</span><h3>Every day is a chance to learn something new.</h3><p>Каждый день — это шанс узнать что-то новое.</p></div>
      <button type="button" class="icon-button" data-action="speak" data-text="Every day is a chance to learn something new." aria-label="Прослушать фразу">🔊</button>
    </section>

    <button class="floating-add" type="button" data-action="add-word" aria-label="Добавить слово">＋</button>
  `;
}

function metricCard(icon, title, value, subtitle, tone) {
  return `<article class="metric-card ${tone}"><span class="metric-icon">${icon}</span><small>${title}</small><strong>${value}</strong><p>${subtitle}</p></article>`;
}

function renderDictionary() {
  const categories = ['Все', ...new Set(state.words.map((word) => word.category).filter(Boolean))];
  const query = state.search.trim().toLowerCase();
  const filtered = state.words.filter((word) => {
    const matchesCategory = state.category === 'Все' || word.category === state.category;
    const haystack = `${word.term} ${word.translation} ${word.example || ''}`.toLowerCase();
    return matchesCategory && (!query || haystack.includes(query));
  });

  view.innerHTML = `
    <section class="page-title-row">
      <div><span class="eyebrow">Личная база</span><h1>Словарь</h1><p>${state.words.length} слов и фраз</p></div>
      <button class="round-action" type="button" data-action="add-word" aria-label="Добавить слово">＋</button>
    </section>

    <button type="button" class="library-entry" data-action="open-library">
      <span class="library-entry-icon">◫</span>
      <span class="grow"><strong>Библиотека слов</strong><small>Готовые наборы A1–C1 · ${LIBRARY_WORDS.length} слов и фраз</small></span>
      <b>›</b>
    </button>

    <label class="search-box"><span>⌕</span><input id="dictionarySearch" type="search" value="${escapeHtml(state.search)}" placeholder="Поиск слов и фраз" autocomplete="off"></label>

    <div class="chip-row" aria-label="Категории">
      ${categories.map((category) => `<button type="button" class="chip ${category === state.category ? 'is-active' : ''}" data-action="set-category" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join('')}
    </div>

    <section class="word-list">
      ${filtered.length ? filtered.map(wordCard).join('') : emptyState('Ничего не найдено', 'Попробуйте другой запрос или добавьте новое слово.')}
    </section>
  `;
}

function renderLibrary() {
  const levels = ['Все', 'A1', 'A2', 'B1', 'B2', 'C1'];
  const topics = ['Все', ...new Set(LIBRARY_WORDS.map((word) => word.topic))];
  const query = state.librarySearch.trim().toLowerCase();
  const personalTerms = new Set(state.words.map((word) => word.term.trim().toLowerCase()));
  const filtered = LIBRARY_WORDS.filter((word) => {
    const levelOk = state.libraryLevel === 'Все' || word.level === state.libraryLevel;
    const topicOk = state.libraryTopic === 'Все' || word.topic === state.libraryTopic;
    const haystack = `${word.term} ${word.translation} ${word.example} ${word.topic}`.toLowerCase();
    return levelOk && topicOk && (!query || haystack.includes(query));
  });

  view.innerHTML = `
    <section class="page-title-row library-title-row">
      <div><span class="eyebrow">Общая учебная база</span><h1>Библиотека</h1><p>${LIBRARY_WORDS.length} проверенных слов и фраз · A1–C1</p></div>
      <button type="button" class="back-dictionary-button" data-action="go-dictionary" aria-label="Вернуться в словарь">←</button>
    </section>
    <section class="library-hero">
      <div><span class="eyebrow">Стартовая коллекция</span><h2>Выберите то, что хотите учить</h2><p>Библиотека не засоряет личный словарь. Слово попадает в занятия только после добавления.</p></div>
      <span class="library-count">${filtered.length}</span>
    </section>
    <label class="search-box"><span>⌕</span><input id="librarySearch" type="search" value="${escapeHtml(state.librarySearch)}" placeholder="Найти слово, перевод или тему" autocomplete="off"></label>
    <div class="chip-row" aria-label="Уровни CEFR">
      ${levels.map((level) => `<button type="button" class="chip ${level === state.libraryLevel ? 'is-active' : ''}" data-action="set-library-level" data-level="${level}">${level}</button>`).join('')}
    </div>
    <div class="chip-row" aria-label="Темы">
      ${topics.map((topic) => `<button type="button" class="chip ${topic === state.libraryTopic ? 'is-active' : ''}" data-action="set-library-topic" data-topic="${escapeHtml(topic)}">${escapeHtml(topic)}</button>`).join('')}
    </div>
    <button type="button" class="secondary-button library-pack-button" data-action="add-library-pack">＋ Добавить показанные (${filtered.filter(w => !personalTerms.has(w.term.toLowerCase())).length})</button>
    <section class="library-list">
      ${filtered.length ? filtered.map((word) => libraryCard(word, personalTerms.has(word.term.toLowerCase()))).join('') : emptyState('Ничего не найдено', 'Измените уровень, тему или поисковый запрос.')}
    </section>
  `;
}

function libraryCard(word, added) {
  return `
    <article class="library-card">
      <div class="library-word-head">
        <span class="cefr-badge cefr-${word.level.toLowerCase()}">${word.level}</span>
        <div class="grow"><h3>${escapeHtml(word.term)}</h3><p>${escapeHtml(word.translation)}</p></div>
        <button type="button" class="icon-button" data-action="speak" data-text="${escapeHtml(word.term)}" aria-label="Прослушать">🔊</button>
      </div>
      <div class="library-meta"><span>${escapeHtml(word.transcription)}</span><span>${escapeHtml(word.partOfSpeech)}</span><span>${escapeHtml(word.topic)}</span></div>
      <div class="library-example"><strong>${escapeHtml(word.example)}</strong><small>${escapeHtml(word.exampleTranslation)}</small></div>
      <button type="button" class="${added ? 'library-added' : 'library-add'}" data-action="add-library-word" data-id="${word.id}" ${added ? 'disabled' : ''}>${added ? '✓ Уже в словаре' : '＋ В мой словарь'}</button>
    </article>
  `;
}

async function addLibraryWord(id, silent = false) {
  const source = LIBRARY_WORDS.find((word) => word.id === id);
  if (!source) return false;
  if (state.words.some((word) => word.term.trim().toLowerCase() === source.term.toLowerCase())) {
    if (!silent) showToast('Это слово уже есть в вашем словаре');
    return false;
  }
  const now = new Date().toISOString();
  const word = normalizeWord({
    ...source,
    id: uid(),
    libraryId: source.id,
    category: source.topic,
    status: 'new',
    favorite: false,
    important: false,
    createdAt: now,
    updatedAt: now,
    nextReviewAt: now,
    syncState: 'pending'
  });
  await putOne('words', word);
  state.words.unshift(word);
  if (!silent) {
    showToast('Добавлено в личный словарь');
    renderLibrary();
  }
  return true;
}

async function addLibraryPack() {
  const query = state.librarySearch.trim().toLowerCase();
  const candidates = LIBRARY_WORDS.filter((word) => {
    const levelOk = state.libraryLevel === 'Все' || word.level === state.libraryLevel;
    const topicOk = state.libraryTopic === 'Все' || word.topic === state.libraryTopic;
    const haystack = `${word.term} ${word.translation} ${word.example} ${word.topic}`.toLowerCase();
    return levelOk && topicOk && (!query || haystack.includes(query));
  });
  let added = 0;
  for (const word of candidates) if (await addLibraryWord(word.id, true)) added += 1;
  showToast(added ? `Добавлено: ${added}` : 'Все показанные слова уже добавлены');
  renderLibrary();
}

function wordCard(word) {
  const statusLabel = { new: 'Новое', learning: 'Изучается', difficult: 'Сложное', learned: 'Усвоено' }[word.status] || 'Новое';
  return `
    <article class="word-card">
      <button class="word-main" type="button" data-action="edit-word" data-id="${word.id}">
        <span class="word-avatar">${escapeHtml(word.term.slice(0, 1).toUpperCase())}</span>
        <span><strong>${escapeHtml(word.term)}</strong><small>${escapeHtml(word.translation)}</small><em>${escapeHtml(word.category || 'Без категории')}</em></span>
      </button>
      <span class="status-pill status-${word.status}">${statusLabel}</span>
      <div class="word-actions">
        <button type="button" data-action="speak" data-text="${escapeHtml(word.term)}" aria-label="Прослушать">🔊</button>
        <button type="button" data-action="toggle-favorite" data-id="${word.id}" aria-label="Избранное">${word.favorite ? '★' : '☆'}</button>
      </div>
    </article>
  `;
}

function renderStudy() {
  if (!state.session) {
    view.innerHTML = `
      <section class="page-title-row"><div><span class="eyebrow">Практика</span><h1>Занятие</h1><p>Повторяйте слова небольшими подходами.</p></div></section>
      <section class="study-start-card">
        <div class="study-orbit"><span>🔊</span><span>ABC</span><span>✍️</span></div>
        <h2>Готовы начать?</h2>
        <p>Приложение подберёт до ${state.settings.sessionLength} слов: сначала просроченные, затем новые.</p>
        <button class="primary-cta" type="button" data-action="start-session"><span><small>Около 3–5 минут</small><strong>Начать занятие</strong></span><span class="cta-arrow">→</span></button>
      </section>
      <section class="mode-grid">
        ${modeCard('🔊', 'Слушать', 'Произношение слов и примеров')}
        ${modeCard('⌨️', 'Печатать', 'Активное вспоминание')}
        ${modeCard('✓', 'Выбирать', 'Быстрая проверка значения')}
      </section>
    `;
    return;
  }

  if (state.session.finished) {
    renderSessionResult();
    return;
  }

  const current = state.session.words[state.session.index];
  const progress = Math.round(((state.session.index) / state.session.words.length) * 100);

  view.innerHTML = `
    <section class="study-header">
      <button type="button" class="icon-button" data-action="finish-session" aria-label="Закрыть занятие">×</button>
      <div><strong>${state.session.index + 1} из ${state.session.words.length}</strong><div class="progress-track"><span style="width:${progress}%"></span></div></div>
      <span class="xp-chip">+${state.session.xp} XP</span>
    </section>

    <article class="flashcard ${state.session.revealed ? 'is-revealed' : ''}">
      <div class="flashcard-top"><span class="status-pill status-${current.status}">${escapeHtml(current.category || 'Слово')}</span><button type="button" class="icon-button" data-action="speak" data-text="${escapeHtml(current.term)}">🔊</button></div>
      <div class="flashcard-word"><h1>${escapeHtml(current.term)}</h1><p>${escapeHtml(current.transcription || '')}</p><small>${escapeHtml(current.pronunciation || '')}</small></div>
      ${state.session.revealed ? `
        <div class="answer-block"><h2>${escapeHtml(current.translation)}</h2>${current.example ? `<p><strong>${escapeHtml(current.example)}</strong><br><span>${escapeHtml(current.exampleTranslation || '')}</span></p><button type="button" class="listen-example" data-action="speak" data-text="${escapeHtml(current.example)}">🔊 Прослушать пример</button>` : ''}</div>
      ` : `<button class="reveal-button" type="button" data-action="reveal-answer">Показать перевод</button>`}
    </article>

    ${state.session.revealed ? `<section class="rating-grid">
      <button type="button" class="rating forget" data-action="rate-answer" data-rating="forget"><span>×</span><strong>Не помню</strong></button>
      <button type="button" class="rating hard" data-action="rate-answer" data-rating="hard"><span>◔</span><strong>Тяжело</strong></button>
      <button type="button" class="rating normal" data-action="rate-answer" data-rating="normal"><span>•</span><strong>Нормально</strong></button>
      <button type="button" class="rating easy" data-action="rate-answer" data-rating="easy"><span>✓</span><strong>Легко</strong></button>
    </section>` : '<p class="study-hint">Попробуйте сначала вспомнить значение самостоятельно.</p>'}
  `;

  if (state.settings.autoPlay) speak(current.term);
}

function modeCard(icon, title, text) {
  return `<article class="mode-card"><span>${icon}</span><strong>${title}</strong><p>${text}</p></article>`;
}

async function startSession() {
  const due = dueWords().sort((a, b) => new Date(a.nextReviewAt) - new Date(b.nextReviewAt));
  const other = state.words.filter((word) => !due.some((item) => item.id === word.id));
  const selected = [...due, ...other].slice(0, Math.max(1, Number(state.settings.sessionLength) || 12));

  if (!selected.length) {
    showToast('Сначала добавьте хотя бы одно слово');
    openWordModal();
    return;
  }

  state.session = {
    id: uid(),
    startedAt: new Date().toISOString(),
    words: selected,
    index: 0,
    revealed: false,
    correct: 0,
    mistakes: 0,
    xp: 0,
    finished: false,
    xpEvents: []
  };
  navigate('study');
}

function revealAnswer() {
  if (!state.session) return;
  state.session.revealed = true;
  renderStudy();
}

async function rateAnswer(rating) {
  if (!state.session) return;
  const word = state.session.words[state.session.index];
  const now = Date.now();
  const oldLevel = levelData(state.profile.totalXp || 0).level;
  let earned = 0;
  let intervalDays = Number(word.intervalDays || 0);

  if (rating === 'forget') {
    word.wrongCount += 1;
    word.status = 'difficult';
    word.nextReviewAt = new Date(now + 60 * 60 * 1000).toISOString();
    state.session.mistakes += 1;
  } else if (rating === 'hard') {
    earned = 1;
    intervalDays = Math.max(1, intervalDays * 1.2 || 1);
    word.correctCount += 1;
    word.status = word.correctCount >= 4 ? 'learned' : 'learning';
    word.nextReviewAt = new Date(now + intervalDays * DAY).toISOString();
    state.session.correct += 1;
  } else if (rating === 'normal') {
    earned = 2;
    intervalDays = Math.max(2, intervalDays * 2.2 || 2);
    word.correctCount += 1;
    word.status = word.correctCount >= 3 ? 'learned' : 'learning';
    word.nextReviewAt = new Date(now + intervalDays * DAY).toISOString();
    state.session.correct += 1;
  } else {
    earned = 3;
    intervalDays = Math.max(4, intervalDays * 3.2 || 4);
    word.correctCount += 1;
    word.status = word.correctCount >= 2 ? 'learned' : 'learning';
    word.nextReviewAt = new Date(now + intervalDays * DAY).toISOString();
    state.session.correct += 1;
  }

  word.intervalDays = intervalDays;
  word.lastReviewedAt = new Date().toISOString();
  word.updatedAt = new Date().toISOString();
  word.syncState = 'pending';

  state.session.xp += earned;
  state.session.xpEvents.push({ wordId: word.id, rating, xp: earned });
  state.profile.totalXp = (state.profile.totalXp || 0) + earned;
  updateStreak();

  await Promise.all([putOne('words', word), putOne('profile', state.profile)]);
  state.words = state.words.map((item) => item.id === word.id ? { ...word } : item);

  state.session.index += 1;
  state.session.revealed = false;
  if (state.session.index >= state.session.words.length) {
    await completeSession();
  }

  const newLevel = levelData(state.profile.totalXp || 0).level;
  if (newLevel > oldLevel) showToast(`Новый уровень: ${newLevel}! 🎉`);
  renderStudy();
}

function updateStreak() {
  const today = todayKey();
  if (state.profile.lastActiveDate === today) return;
  const yesterday = todayKey(new Date(Date.now() - DAY));
  state.profile.streak = state.profile.lastActiveDate === yesterday ? (state.profile.streak || 0) + 1 : 1;
  state.profile.lastActiveDate = today;
}

async function completeSession() {
  state.session.xp += 15;
  state.profile.totalXp = (state.profile.totalXp || 0) + 15;
  state.session.finished = true;
  state.session.completedAt = new Date().toISOString();

  const stored = {
    id: state.session.id,
    startedAt: state.session.startedAt,
    completedAt: state.session.completedAt,
    reviewed: state.session.words.length,
    correct: state.session.correct,
    mistakes: state.session.mistakes,
    xp: state.session.xp,
    xpEvents: state.session.xpEvents,
    syncState: 'pending'
  };
  state.sessions.push(stored);
  await Promise.all([putOne('sessions', stored), putOne('profile', state.profile)]);
}

function renderSessionResult() {
  const accuracy = Math.round((state.session.correct / state.session.words.length) * 100);
  const level = levelData(state.profile.totalXp || 0);
  view.innerHTML = `
    <section class="result-card">
      <div class="result-icon">✓</div>
      <span class="eyebrow">Занятие завершено</span>
      <h1>Отличная работа!</h1>
      <p>Каждое повторение делает нужные слова доступнее в реальной речи.</p>
      <div class="result-stats"><span><strong>${state.session.words.length}</strong><small>повторено</small></span><span><strong>${accuracy}%</strong><small>точность</small></span><span><strong>+${state.session.xp}</strong><small>XP</small></span></div>
      <div class="level-result"><div><strong>Уровень ${level.level} · ${level.rank.name}</strong><small>${level.currentXp} / ${level.requiredXp} XP</small></div><div class="progress-track"><span style="width:${level.percent}%"></span></div></div>
      <button class="primary-cta" type="button" data-action="finish-session"><span><small>Продолжить обучение</small><strong>Вернуться на главную</strong></span><span class="cta-arrow">→</span></button>
    </section>
  `;
}

function finishSessionView() {
  state.session = null;
  navigate('today');
}

function renderProgress() {
  const total = state.words.length;
  const learned = learnedWords().length;
  const difficult = state.words.filter((word) => word.status === 'difficult').length;
  const reviewed = state.sessions.reduce((sum, session) => sum + (session.reviewed || 0), 0);
  const correct = state.sessions.reduce((sum, session) => sum + (session.correct || 0), 0);
  const accuracy = reviewed ? Math.round((correct / reviewed) * 100) : 0;
  const lastSeven = dailyActivity(7);
  const maxActivity = Math.max(1, ...lastSeven.map((day) => day.count));
  const categories = [...new Set(state.words.map((word) => word.category).filter(Boolean))]
    .map((category) => ({ category, count: state.words.filter((word) => word.category === category).length }))
    .sort((a, b) => b.count - a.count);

  view.innerHTML = `
    <section class="page-title-row"><div><span class="eyebrow">Статистика</span><h1>Прогресс</h1><p>Не только собранные слова, но и реальные повторения.</p></div></section>
    <section class="stats-grid">
      ${metricCard('📘', 'Активный словарь', learned, 'усвоено', 'blue')}
      ${metricCard('↻', 'Повторений', reviewed, 'за всё время', 'teal')}
      ${metricCard('◎', 'Точность', `${accuracy}%`, 'ответов', 'yellow')}
      ${metricCard('!', 'Сложные', difficult, 'требуют внимания', 'violet')}
    </section>

    <section class="panel">
      <div class="section-heading"><div><span class="eyebrow">Последние 7 дней</span><h2>Активность</h2></div><strong>${sessionsLastDays(7).length} занятий</strong></div>
      <div class="bar-chart">
        ${lastSeven.map((day) => `<div class="bar-column"><div class="bar-track"><span style="height:${Math.max(5, Math.round(day.count / maxActivity * 100))}%"></span></div><small>${day.label}</small></div>`).join('')}
      </div>
    </section>

    <section class="panel">
      <div class="section-heading"><div><span class="eyebrow">Ваши темы</span><h2>Категории</h2></div><strong>${total}</strong></div>
      <div class="category-list">
        ${categories.length ? categories.map((item) => `<div><span>${escapeHtml(item.category)}</span><div class="progress-track"><span style="width:${Math.round(item.count / total * 100)}%"></span></div><strong>${item.count}</strong></div>`).join('') : '<p>Категории появятся после добавления слов.</p>'}
      </div>
    </section>
  `;
}

function dailyActivity(days) {
  const result = [];
  const labels = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * DAY);
    const key = todayKey(date);
    const count = state.sessions.filter((session) => session.completedAt?.startsWith(key)).reduce((sum, session) => sum + (session.reviewed || 0), 0);
    result.push({ key, label: labels[date.getDay()], count });
  }
  return result;
}

function sessionsLastDays(days) {
  const threshold = Date.now() - days * DAY;
  return state.sessions.filter((session) => new Date(session.completedAt || 0).getTime() >= threshold);
}

function renderProfile() {
  const level = levelData(state.profile.totalXp || 0);
  view.innerHTML = `
    <section class="profile-hero">
      <div class="avatar">${escapeHtml((state.profile.displayName || 'Г').slice(0, 1).toUpperCase())}</div>
      <div><span class="eyebrow">Профиль</span><h1>${escapeHtml(state.profile.displayName)}</h1><p>${state.profile.accountStatus === 'guest' ? 'Гостевой режим · данные хранятся локально' : escapeHtml(state.profile.email)}</p></div>
      <span class="profile-level">${level.rank.icon} ${level.level}</span>
    </section>

    <section class="account-card">
      <span class="account-icon">☁</span>
      <div class="grow"><strong>${state.profile.accountStatus === 'guest' ? 'Подключите аккаунт' : 'Синхронизация включена'}</strong><p>${state.profile.accountStatus === 'guest' ? 'Регистрация, восстановление и синхронизация между устройствами предусмотрены архитектурой проекта.' : 'Изменения сохраняются локально и синхронизируются с сервером.'}</p></div>
      <button type="button" class="secondary-button" data-action="account-info">${state.profile.accountStatus === 'guest' ? 'Подробнее' : 'Управление'}</button>
    </section>

    <section class="settings-panel">
      <h2>Обучение</h2>
      ${settingSelect('Новых слов в день', 'Небольшая ежедневная порция', 'newWordsPerDay', state.settings.newWordsPerDay, [5, 10, 15, 20])}
      ${settingSelect('Длительность занятия', 'Количество карточек за подход', 'sessionLength', state.settings.sessionLength, [5, 8, 12, 20])}
      ${settingSelectText('Английский голос', 'Основной вариант произношения', 'voiceLang', state.settings.voiceLang, [{ value: 'en-US', label: 'Американский' }, { value: 'en-GB', label: 'Британский' }])}
      ${settingSelect('Скорость речи', 'Можно замедлить произношение', 'speechRate', state.settings.speechRate, [0.65, 0.8, 0.85, 1])}
      ${settingToggle('Автовоспроизведение', 'Произносить слово при открытии карточки', 'autoPlay', state.settings.autoPlay)}
    </section>

    <section class="settings-panel">
      <h2>Данные и PWA</h2>
      ${actionSetting('⇧', 'Экспорт данных', 'Сохранить резервную копию в JSON', 'export-data')}
      ${actionSetting('⇩', 'Импорт данных', 'Восстановить словарь и прогресс', 'trigger-import')}
      ${actionSetting('⌂', 'Установить на экран Домой', 'Открывать как отдельное приложение', 'install-app')}
      <input id="importFile" type="file" accept="application/json" hidden>
    </section>

    <section class="version-card"><span>English Vocabulary</span><strong>Версия ${APP_VERSION}</strong><small>Локальная база IndexedDB · PWA offline-first</small></section>
  `;
}

function settingSelect(title, description, key, current, options) {
  return `<label class="setting-row"><span><strong>${title}</strong><small>${description}</small></span><select data-setting="${key}">${options.map((value) => `<option value="${value}" ${Number(current) === Number(value) ? 'selected' : ''}>${key === 'speechRate' ? `${value}×` : value}</option>`).join('')}</select></label>`;
}

function settingSelectText(title, description, key, current, options) {
  return `<label class="setting-row"><span><strong>${title}</strong><small>${description}</small></span><select data-setting="${key}">${options.map((item) => `<option value="${item.value}" ${current === item.value ? 'selected' : ''}>${item.label}</option>`).join('')}</select></label>`;
}

function settingToggle(title, description, key, checked) {
  return `<label class="setting-row"><span><strong>${title}</strong><small>${description}</small></span><input class="switch" type="checkbox" data-setting="${key}" ${checked ? 'checked' : ''}></label>`;
}

function actionSetting(icon, title, description, action) {
  return `<button type="button" class="setting-row action-row" data-action="${action}"><span class="setting-icon">${icon}</span><span><strong>${title}</strong><small>${description}</small></span><b>›</b></button>`;
}

function openWordModal(word = null) {
  const editing = Boolean(word);
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-action="close-modal"></div>
    <section class="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="wordModalTitle">
      <div class="modal-handle"></div>
      <header><div><span class="eyebrow">${editing ? 'Редактирование' : 'Новая карточка'}</span><h2 id="wordModalTitle">${editing ? 'Карточка слова' : 'Добавить слово'}</h2></div><button type="button" class="icon-button" data-action="close-modal">×</button></header>
      <form id="wordForm" class="word-form" data-word-id="${word?.id || ''}" onsubmit="return false">
        ${formField('Английское слово или фраза', 'term', word?.term, 'available', true)}
        ${formField('Перевод', 'translation', word?.translation, 'доступный; имеющийся', true)}
        <div class="form-grid">${formField('Подсказка произношения', 'pronunciation', word?.pronunciation, 'эвэ́йлэбл')}${formField('Транскрипция', 'transcription', word?.transcription, '/əˈveɪləbl/')}</div>
        ${formField('Пример', 'example', word?.example, 'The cabin is available.')}
        ${formField('Перевод примера', 'exampleTranslation', word?.exampleTranslation, 'Каюта свободна.')}
        <div class="form-grid">${formField('Категория', 'category', word?.category, 'Судно')}${formField('Часть речи', 'partOfSpeech', word?.partOfSpeech, 'adjective')}</div>
        <label class="toggle-field"><span><strong>Важное слово</strong><small>Показывать чаще в повторениях</small></span><input name="important" class="switch" type="checkbox" ${word?.important ? 'checked' : ''}></label>
        <button class="primary-cta" type="button" data-action="save-word"><span><small>${editing ? 'Сохранить изменения' : 'Добавить в словарь'}</small><strong>${editing ? 'Сохранить' : 'Добавить слово'}</strong></span><span class="cta-arrow">✓</span></button>
        ${editing ? `<button type="button" class="danger-button" data-action="delete-word" data-id="${word.id}">Удалить карточку</button>` : ''}
      </form>
    </section>
  `;
  document.body.classList.add('modal-open');
  setTimeout(() => document.querySelector('[name="term"]')?.focus(), 50);
}

function formField(label, name, value = '', placeholder = '', required = false) {
  return `<label class="form-field"><span>${label}</span><input name="${name}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder)}" ${required ? 'required' : ''}></label>`;
}

async function saveWordFromForm() {
  const form = document.querySelector('#wordForm');
  if (!form) return;
  const data = new FormData(form);
  const term = String(data.get('term') || '').trim();
  const translation = String(data.get('translation') || '').trim();
  if (!term || !translation) {
    showToast('Заполните слово и перевод');
    return;
  }

  const id = form.dataset.wordId || uid();
  const existing = state.words.find((word) => word.id === id);
  const word = normalizeWord({
    ...existing,
    id,
    term,
    translation,
    pronunciation: String(data.get('pronunciation') || '').trim(),
    transcription: String(data.get('transcription') || '').trim(),
    example: String(data.get('example') || '').trim(),
    exampleTranslation: String(data.get('exampleTranslation') || '').trim(),
    category: String(data.get('category') || '').trim() || 'Без категории',
    partOfSpeech: String(data.get('partOfSpeech') || '').trim(),
    important: data.get('important') === 'on',
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nextReviewAt: existing?.nextReviewAt || new Date().toISOString(),
    syncState: 'pending'
  });

  await putOne('words', word);
  state.words = existing ? state.words.map((item) => item.id === id ? word : item) : [word, ...state.words];
  closeModal();
  showToast(existing ? 'Карточка обновлена' : 'Слово добавлено');
  render();
}

async function deleteWord(id) {
  const word = state.words.find((item) => item.id === id);
  if (!word || !confirm(`Удалить «${word.term}»?`)) return;
  await deleteOne('words', id);
  state.words = state.words.filter((item) => item.id !== id);
  closeModal();
  showToast('Карточка удалена');
  render();
}

async function toggleFavorite(id) {
  const word = state.words.find((item) => item.id === id);
  if (!word) return;
  word.favorite = !word.favorite;
  word.updatedAt = new Date().toISOString();
  word.syncState = 'pending';
  await putOne('words', word);
  renderDictionary();
}

function closeModal() {
  modalRoot.innerHTML = '';
  document.body.classList.remove('modal-open');
}

function openLevelModal() {
  const level = levelData(state.profile.totalXp || 0);
  const nextRankLevel = level.level <= 5 ? 6 : level.level <= 10 ? 11 : level.level <= 15 ? 16 : level.level <= 20 ? 21 : level.level <= 25 ? 26 : null;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-action="close-modal"></div>
    <section class="modal-sheet compact-sheet" role="dialog" aria-modal="true">
      <div class="modal-handle"></div>
      <header><div><span class="eyebrow">Мотивация</span><h2>Уровень ${level.level}</h2></div><button type="button" class="icon-button" data-action="close-modal">×</button></header>
      <div class="big-level-icon">${level.rank.icon}<strong>${level.level}</strong></div>
      <h3 class="centered">${level.rank.name}</h3>
      <div class="progress-track large"><span style="width:${level.percent}%"></span></div>
      <p class="centered">${level.currentXp} из ${level.requiredXp} XP · осталось ${level.requiredXp - level.currentXp} XP</p>
      ${nextRankLevel ? `<div class="next-rank">Следующий ранг откроется на уровне <strong>${nextRankLevel}</strong>.</div>` : '<div class="next-rank">Высший текущий ранг. Новые уровни можно добавить позже.</div>'}
      <small class="modal-note">XP начисляется за полезные учебные действия. Ошибки не отнимают уже полученный опыт.</small>
    </section>
  `;
  document.body.classList.add('modal-open');
}

function openAccountModal() {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-action="close-modal"></div>
    <section class="modal-sheet compact-sheet" role="dialog" aria-modal="true">
      <div class="modal-handle"></div>
      <header><div><span class="eyebrow">Многопользовательская архитектура</span><h2>Аккаунты и синхронизация</h2></div><button type="button" class="icon-button" data-action="close-modal">×</button></header>
      <div class="feature-stack">
        <div><span>✓</span><p><strong>Раздельные данные</strong><small>У каждого аккаунта будет собственный словарь, прогресс и настройки.</small></p></div>
        <div><span>✓</span><p><strong>Local-first</strong><small>Обучение продолжит работать офлайн, а изменения синхронизируются после подключения.</small></p></div>
        <div><span>→</span><p><strong>Следующий серверный этап</strong><small>Регистрацию и безопасную авторизацию подключим отдельным Cloudflare Worker и отдельной D1-базой английского приложения.</small></p></div>
      </div>
      <p class="modal-note">Сейчас версия 0.2.2 честно работает в гостевом режиме и уже хранит данные в отдельной IndexedDB.</p>
    </section>
  `;
  document.body.classList.add('modal-open');
}

function speak(text) {
  if (!text || !('speechSynthesis' in window)) {
    showToast('Озвучивание недоступно на этом устройстве');
    return;
  }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = state.settings.voiceLang || 'en-US';
  utterance.rate = Number(state.settings.speechRate) || 0.85;
  const voices = speechSynthesis.getVoices();
  const preferred = voices.find((voice) => voice.lang === utterance.lang) || voices.find((voice) => voice.lang.startsWith('en'));
  if (preferred) utterance.voice = preferred;
  speechSynthesis.speak(utterance);
}

async function exportData() {
  try {
    const payload = await exportDatabase();
    payload.version = APP_VERSION;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `english-vocabulary-backup-${todayKey()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Резервная копия создана');
  } catch (error) {
    console.error(error);
    showToast('Не удалось создать резервную копию');
  }
}

async function importData(file) {
  try {
    const payload = JSON.parse(await file.text());
    await importDatabase(payload);
    const [words, sessions, profile, settings] = await Promise.all([
      getAll('words'), getAll('sessions'), getOne('profile', 'current'), getOne('settings', 'main')
    ]);
    state.words = words.map(normalizeWord);
    state.sessions = sessions;
    state.profile = profile || { ...defaultProfile };
    state.settings = { ...defaultSettings, ...(settings || {}) };
    showToast('Данные восстановлены');
    render();
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Не удалось импортировать данные');
  }
}

async function installApp() {
  if (state.deferredInstallPrompt) {
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    return;
  }

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-action="close-modal"></div>
    <section class="modal-sheet compact-sheet" role="dialog" aria-modal="true">
      <div class="modal-handle"></div>
      <header><div><span class="eyebrow">Установка PWA</span><h2>На экран Домой</h2></div><button type="button" class="icon-button" data-action="close-modal">×</button></header>
      <div class="install-steps">${isIos ? '<p><strong>1.</strong> Откройте меню «Поделиться» в Safari.</p><p><strong>2.</strong> Выберите «На экран Домой».</p><p><strong>3.</strong> Нажмите «Добавить».</p>' : '<p>Откройте меню браузера и выберите «Установить приложение» или «Добавить на главный экран».</p>'}</div>
    </section>
  `;
  document.body.classList.add('modal-open');
}

function updateConnectionState() {
  connectionBar.hidden = navigator.onLine;
}

function emptyState(title, text) {
  return `<div class="empty-state"><span>⌕</span><h3>${title}</h3><p>${text}</p><button type="button" class="secondary-button" data-action="add-word">Добавить слово</button></div>`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => toast.classList.remove('is-visible'), 2400);
}

async function resetDemoProgress() {
  if (!confirm('Сбросить только прогресс и XP? Слова останутся в словаре.')) return;
  state.profile.totalXp = 0;
  state.profile.streak = 0;
  state.profile.lastActiveDate = null;
  state.sessions = [];
  await putOne('profile', state.profile);
  showToast('Прогресс сброшен');
  render();
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    if (navigator.onLine) registration.update().catch(() => {});
  } catch (error) {
    console.warn('Service Worker registration failed', error);
  }
}

bootstrap().catch((error) => {
  console.error(error);
  view.innerHTML = `<div class="fatal-error"><h1>Не удалось запустить приложение</h1><p>${escapeHtml(error.message)}</p><button onclick="location.reload()">Попробовать снова</button></div>`;
});
