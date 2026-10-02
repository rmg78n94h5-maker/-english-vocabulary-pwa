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
const APP_VERSION = '0.4.0';
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
  newWordsPerDay: 5,
  sessionLength: 12,
  voiceLang: 'en-US',
  speechRate: 0.85,
  autoPlay: false,
  theme: 'light',
  smartNewWords: true,
  learningLevel: 'A1-B1',
  syncEnabled: false
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
  const normalized = {
    intervalDays: 0,
    stabilityDays: 0,
    difficulty: 0.5,
    mastery: 0,
    correctCount: 0,
    wrongCount: 0,
    lapses: 0,
    consecutiveCorrect: 0,
    seenCount: 0,
    introducedAt: null,
    lastPresentedAt: null,
    lastSessionId: null,
    lastExercise: '',
    favorite: false,
    important: false,
    status: 'new',
    source: 'manual',
    syncState: 'local',
    ...word
  };
  normalized.seenCount = Number(normalized.seenCount || 0) || Number(normalized.correctCount || 0) + Number(normalized.wrongCount || 0);
  normalized.stabilityDays = Number(normalized.stabilityDays || normalized.intervalDays || 0);
  normalized.mastery = Number(normalized.mastery || calculateMastery(normalized));
  return normalized;
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
    case 'answer-option': await answerOption(Number(actionElement.dataset.option)); break;
    case 'check-typing': await checkTypingAnswer(); break;
    case 'next-task': await advanceStudyTask(); break;
    case 'intro-next': await finishIntroTask(); break;
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
    const numericSettings = new Set(['newWordsPerDay', 'sessionLength', 'speechRate']);
    const value = event.target.type === 'checkbox'
      ? event.target.checked
      : numericSettings.has(key)
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
      <div><span class="eyebrow">Общая учебная база</span><h1>Библиотека</h1><p>${LIBRARY_WORDS.length} слов и фраз · A1–C1</p></div>
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
      <div class="library-meta">${word.transcription ? `<span>${escapeHtml(word.transcription)}</span>` : ''}${word.partOfSpeech ? `<span>${escapeHtml(word.partOfSpeech)}</span>` : ''}<span>${escapeHtml(word.topic)}</span></div>
      ${word.example ? `<div class="library-example"><strong>${escapeHtml(word.example)}</strong><small>${escapeHtml(word.exampleTranslation || '')}</small></div>` : ''}
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
    const due = dueWords().length;
    const difficult = state.words.filter((word) => word.status === 'difficult').length;
    const fresh = state.words.filter((word) => word.status === 'new').length;
    view.innerHTML = `
      <section class="page-title-row"><div><span class="eyebrow">Умный микс</span><h1>Занятие</h1><p>Приложение само смешает повторение, слабые места и немного нового.</p></div></section>
      <section class="study-start-card smart-study-card">
        <div class="study-orbit"><span>🔊</span><span>ABC</span><span>⌨️</span></div>
        <h2>Без зубрёжки по кругу</h2>
        <p>Сначала — то, что пора повторить. Затем слабые слова. Новые добавляются маленькими порциями, а хорошо знакомые не лезут в каждое занятие.</p>
        <div class="smart-mix-preview"><span><strong>${due}</strong><small>пора повторить</small></span><span><strong>${difficult}</strong><small>сложных</small></span><span><strong>${fresh}</strong><small>новых</small></span></div>
        <button class="primary-cta" type="button" data-action="start-session"><span><small>${state.settings.sessionLength} заданий · около 3–5 минут</small><strong>Начать умное занятие</strong></span><span class="cta-arrow">→</span></button>
      </section>
      <section class="mode-grid">
        ${modeCard('✓', 'Выбор', 'Быстро узнаём значение')}
        ${modeCard('⌨️', 'Вспомнить', 'Русский → английский без подсказки')}
        ${modeCard('🔊', 'На слух', 'Слушаем и узнаём слово')}
      </section>
      <section class="panel learning-logic-panel"><span class="eyebrow">Как это работает</span><h2>Сложность растёт вместе с вами</h2><p>Новое слово сначала знакомится с вами, затем появляется в простом выборе. Когда оно закрепляется, чаще приходят ввод с клавиатуры, аудирование и контекст.</p></section>
    `;
    return;
  }

  if (state.session.finished) {
    renderSessionResult();
    return;
  }

  const task = currentStudyTask();
  if (!task) {
    completeSession().then(() => renderStudy());
    return;
  }
  const word = state.words.find((item) => item.id === task.wordId);
  if (!word) {
    state.session.index += 1;
    renderStudy();
    return;
  }

  const progress = Math.round((state.session.index / Math.max(1, state.session.tasks.length)) * 100);
  const answeredClass = task.answered ? (task.correct ? 'is-correct' : 'is-wrong') : '';

  view.innerHTML = `
    <section class="study-header">
      <button type="button" class="icon-button" data-action="finish-session" aria-label="Закрыть занятие">×</button>
      <div><strong>${Math.min(state.session.index + 1, state.session.tasks.length)} из ${state.session.tasks.length}</strong><div class="progress-track"><span style="width:${progress}%"></span></div></div>
      <span class="xp-chip">+${state.session.xp} XP</span>
    </section>
    <article class="smart-task ${answeredClass}">
      ${renderExercise(task, word)}
      ${task.answered ? renderAnswerFeedback(task, word) : ''}
    </article>
  `;

  if (!task.answered && task.type === 'typing') {
    setTimeout(() => document.querySelector('#typingAnswer')?.focus(), 40);
  }
  if (!task.answered && task.type === 'listening' && (state.settings.autoPlay || !task.playedOnce)) {
    task.playedOnce = true;
    setTimeout(() => speak(word.term), 120);
  }
}

function modeCard(icon, title, text) {
  return `<article class="mode-card"><span>${icon}</span><strong>${title}</strong><p>${text}</p></article>`;
}

function currentStudyTask() {
  return state.session?.tasks?.[state.session.index] || null;
}

function renderExercise(task, word) {
  const top = `<div class="smart-task-top"><span class="exercise-chip">${exerciseLabel(task.type)}</span><span class="mastery-chip">${Math.round(Number(word.mastery || 0) * 100)}%</span></div>`;

  if (task.type === 'intro') {
    return `${top}<div class="intro-card"><span class="eyebrow">Новое слово</span><h1>${escapeHtml(word.term)}</h1>${word.transcription ? `<p class="intro-transcription">${escapeHtml(word.transcription)}</p>` : ''}<button type="button" class="listen-word-big" data-action="speak" data-text="${escapeHtml(word.term)}">🔊 Прослушать</button><h2>${escapeHtml(word.translation)}</h2>${word.pronunciation ? `<small>${escapeHtml(word.pronunciation)}</small>` : ''}${word.example ? `<div class="intro-example"><strong>${escapeHtml(word.example)}</strong><span>${escapeHtml(word.exampleTranslation || '')}</span></div>` : ''}<button type="button" class="primary-cta compact-cta" data-action="intro-next"><span><small>Сейчас вернёмся к нему ещё раз</small><strong>Понятно, дальше</strong></span><span class="cta-arrow">→</span></button></div>`;
  }

  if (task.type === 'choice') {
    return `${top}<div class="task-prompt"><small>Выберите перевод</small><h1>${escapeHtml(word.term)}</h1>${word.transcription ? `<p>${escapeHtml(word.transcription)}</p>` : ''}</div>${renderOptions(task)}`;
  }

  if (task.type === 'reverse') {
    return `${top}<div class="task-prompt"><small>Как будет по-английски?</small><h2>${escapeHtml(word.translation)}</h2></div>${renderOptions(task)}`;
  }

  if (task.type === 'listening') {
    return `${top}<div class="task-prompt listening-prompt"><small>Что вы слышите?</small><button type="button" class="listen-orb" data-action="speak" data-text="${escapeHtml(word.term)}">🔊</button><p>Нажмите, чтобы прослушать ещё раз</p></div>${renderOptions(task)}`;
  }

  if (task.type === 'context') {
    return `${top}<div class="task-prompt context-prompt"><small>Вставьте слово в контекст</small><h2>${escapeHtml(makeCloze(word.example || '', word.term))}</h2>${word.exampleTranslation ? `<p>${escapeHtml(word.exampleTranslation)}</p>` : ''}</div>${renderOptions(task)}`;
  }

  return `${top}<div class="task-prompt"><small>Введите по-английски</small><h2>${escapeHtml(word.translation)}</h2>${word.exampleTranslation ? `<p>${escapeHtml(word.exampleTranslation)}</p>` : ''}</div><div class="typing-box"><input id="typingAnswer" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Ваш ответ"><button type="button" data-action="check-typing">Проверить</button></div>`;
}

function renderOptions(task) {
  return `<div class="answer-options">${task.options.map((option, index) => `<button type="button" data-action="answer-option" data-option="${index}">${escapeHtml(option)}</button>`).join('')}</div>`;
}

function renderAnswerFeedback(task, word) {
  const correctText = task.type === 'choice' ? word.translation : word.term;
  return `<div class="answer-feedback ${task.correct ? 'correct' : 'wrong'}"><strong>${task.correct ? 'Верно ✓' : 'Не страшно — закрепим ещё раз'}</strong>${task.correct ? '<span>Идём дальше.</span>' : `<span>Правильный ответ: <b>${escapeHtml(correctText)}</b></span>`}${word.example ? `<small>${escapeHtml(word.example)} — ${escapeHtml(word.exampleTranslation || '')}</small>` : ''}<button type="button" data-action="next-task">Дальше →</button></div>`;
}

function exerciseLabel(type) {
  return { intro: 'Знакомство', choice: 'Выбор', reverse: 'Вспоминание', typing: 'Печать', listening: 'Аудирование', context: 'Контекст' }[type] || 'Практика';
}

async function startSession() {
  const targetTasks = Math.max(6, Number(state.settings.sessionLength) || 12);
  await ensureSmartNewWords(Math.min(2, Math.max(1, Math.round(targetTasks * 0.18))));

  const previousSessionId = state.sessions.at(-1)?.id || null;
  const newLimit = Math.min(3, Math.max(1, Math.round(targetTasks * 0.25)));
  const newPool = state.words
    .filter((word) => Number(word.seenCount || 0) === 0 || word.status === 'new')
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

  const scored = state.words
    .filter((word) => !newPool.some((item) => item.id === word.id))
    .map((word) => ({ word, score: studyPriority(word, previousSessionId) }))
    .sort((a, b) => b.score - a.score);

  const selectedNew = newPool.slice(0, newLimit);
  const uniqueTarget = Math.max(4, Math.min(state.words.length, Math.round(targetTasks * 0.75)));
  const selectedReview = scored.slice(0, Math.max(0, uniqueTarget - selectedNew.length)).map((item) => item.word);
  let selected = mixWordGroups(selectedReview, selectedNew);

  if (!selected.length) {
    showToast('Сначала добавьте хотя бы одно слово');
    openWordModal();
    return;
  }

  const tasks = selected.map((word) => createStudyTask(word));
  // Новое слово получит ещё одно задание после знакомства. Остаток добиваем
  // разными упражнениями на уже знакомых словах, а не бесконечным показом одной карточки.
  let expectedTasks = tasks.length + selectedNew.length;
  let boosterIndex = 0;
  while (expectedTasks < targetTasks && selectedReview.length) {
    const word = selectedReview[boosterIndex % selectedReview.length];
    tasks.push(createStudyTask(word, { forceType: chooseExerciseType(word, true) }));
    boosterIndex += 1;
    expectedTasks += 1;
  }
  const sessionId = uid();
  state.session = {
    id: sessionId,
    startedAt: new Date().toISOString(),
    words: selected,
    tasks,
    index: 0,
    correct: 0,
    mistakes: 0,
    answered: 0,
    xp: 0,
    finished: false,
    xpEvents: [],
    repeatCounts: {}
  };
  navigate('study');
}

function mixWordGroups(reviewWords, newWords) {
  const reviews = [...reviewWords];
  const fresh = [...newWords];
  const result = [];
  let freshIndex = 0;
  for (let i = 0; i < reviews.length; i += 1) {
    result.push(reviews[i]);
    if (freshIndex < fresh.length && (i === 1 || (i > 1 && (i + 1) % 4 === 0))) result.push(fresh[freshIndex++]);
  }
  while (freshIndex < fresh.length) result.push(fresh[freshIndex++]);
  return result;
}

function studyPriority(word, previousSessionId) {
  const now = Date.now();
  const dueAt = new Date(word.nextReviewAt || 0).getTime();
  const overdueHours = Math.max(0, (now - dueAt) / 3_600_000);
  const isDue = dueAt <= now;
  let score = isDue ? 55 + Math.min(35, Math.log2(overdueHours + 1) * 6) : 0;
  if (word.status === 'difficult') score += 35;
  if (word.important) score += 12;
  score += Math.min(24, Number(word.wrongCount || 0) * 3);
  score += Math.max(0, 12 - Number(word.consecutiveCorrect || 0) * 2);
  score += (1 - Number(word.mastery || 0)) * 18;
  if (word.lastSessionId && word.lastSessionId === previousSessionId && !isDue && word.status !== 'difficult') score -= 60;
  if (word.lastPresentedAt) {
    const hoursAgo = (now - new Date(word.lastPresentedAt).getTime()) / 3_600_000;
    if (hoursAgo < 12 && !isDue) score -= 25;
  }
  if (word.status === 'learned' && !isDue) score -= 22;
  return score + Math.random() * 3;
}

function createStudyTask(word, { forceType = null, isRepeat = false } = {}) {
  const type = forceType || chooseExerciseType(word, isRepeat);
  const task = { id: uid(), wordId: word.id, type, answered: false, correct: null, isRepeat };
  if (['choice', 'reverse', 'listening', 'context'].includes(type)) task.options = buildOptions(word, type);
  return task;
}

function chooseExerciseType(word, isRepeat = false) {
  const seen = Number(word.seenCount || 0);
  const mastery = Number(word.mastery || 0);
  if (seen === 0 && !isRepeat) return 'intro';

  let pool;
  if (isRepeat || word.status === 'difficult' || mastery < 0.3) pool = ['choice', 'reverse', 'listening'];
  else if (mastery < 0.62) pool = ['choice', 'reverse', 'listening', 'typing'];
  else pool = ['reverse', 'typing', 'listening', ...(word.example && word.example.toLowerCase().includes(word.term.toLowerCase()) ? ['context'] : [])];

  const filtered = pool.filter((type) => type !== word.lastExercise);
  const candidates = filtered.length ? filtered : pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function buildOptions(word, type) {
  const answer = type === 'choice' ? word.translation : word.term;
  const field = type === 'choice' ? 'translation' : 'term';
  const candidates = [...state.words, ...LIBRARY_WORDS]
    .filter((item) => item.term?.toLowerCase() !== word.term.toLowerCase())
    .sort((a, b) => {
      const topicA = a.topic === word.topic || a.category === word.category ? 1 : 0;
      const topicB = b.topic === word.topic || b.category === word.category ? 1 : 0;
      return topicB - topicA || Math.random() - 0.5;
    })
    .map((item) => String(item[field] || '').trim())
    .filter(Boolean);
  const unique = [];
  const seen = new Set([answer.toLowerCase()]);
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(candidate);
    }
    if (unique.length >= 3) break;
  }
  const options = [answer, ...unique];
  while (options.length < 4) options.push('—');
  return shuffle(options);
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function makeCloze(example, term) {
  if (!example || !term) return example;
  return example.replace(new RegExp(escapeRegExp(term), 'i'), '_____');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function finishIntroTask() {
  const task = currentStudyTask();
  if (!task || task.type !== 'intro') return;
  const word = state.words.find((item) => item.id === task.wordId);
  if (!word) return;

  const now = new Date().toISOString();
  word.introducedAt ||= now;
  word.lastPresentedAt = now;
  word.lastSessionId = state.session.id;
  word.lastExercise = 'intro';
  word.updatedAt = now;
  word.syncState = 'pending';
  await putOne('words', word);
  state.words = state.words.map((item) => item.id === word.id ? { ...word } : item);

  const insertAt = Math.min(state.session.tasks.length, state.session.index + 3);
  state.session.tasks.splice(insertAt, 0, createStudyTask(word, { forceType: 'choice' }));
  state.session.index += 1;
  renderStudy();
}

async function answerOption(optionIndex) {
  const task = currentStudyTask();
  if (!task || task.answered) return;
  const word = state.words.find((item) => item.id === task.wordId);
  if (!word) return;
  const chosen = task.options?.[optionIndex];
  const expected = task.type === 'choice' ? word.translation : word.term;
  await evaluateStudyAnswer(task, word, normalizeAnswer(chosen) === normalizeAnswer(expected), chosen || '');
}

async function checkTypingAnswer() {
  const task = currentStudyTask();
  if (!task || task.answered || task.type !== 'typing') return;
  const word = state.words.find((item) => item.id === task.wordId);
  const input = document.querySelector('#typingAnswer');
  if (!word || !input) return;
  const value = String(input.value || '').trim();
  if (!value) {
    showToast('Введите ответ');
    return;
  }
  await evaluateStudyAnswer(task, word, normalizeAnswer(value) === normalizeAnswer(word.term), value);
}

function normalizeAnswer(value) {
  return String(value || '').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/[.,!?;:]+$/g, '').replace(/\s+/g, ' ');
}

async function evaluateStudyAnswer(task, word, correct, answer) {
  if (task.answered) return;
  task.answered = true;
  task.correct = correct;
  task.answer = answer;
  const oldLevel = levelData(state.profile.totalXp || 0).level;
  const wasLearned = word.status === 'learned';
  const earned = updateWordMemory(word, correct, task.type);
  const masteryBonus = !wasLearned && word.status === 'learned' ? 5 : 0;
  const repeatXp = task.isRepeat ? Math.min(1, earned) : earned;
  const totalXp = repeatXp + masteryBonus;

  state.session.answered += 1;
  if (correct) state.session.correct += 1;
  else {
    state.session.mistakes += 1;
    const repeats = Number(state.session.repeatCounts[word.id] || 0);
    if (repeats < 2) {
      state.session.repeatCounts[word.id] = repeats + 1;
      const insertAt = Math.min(state.session.tasks.length, state.session.index + 3);
      state.session.tasks.splice(insertAt, 0, createStudyTask(word, { forceType: repeats ? 'reverse' : 'choice', isRepeat: true }));
    }
  }

  word.lastSessionId = state.session.id;
  word.lastPresentedAt = new Date().toISOString();
  word.lastExercise = task.type;
  word.updatedAt = new Date().toISOString();
  word.syncState = 'pending';

  state.session.xp += totalXp;
  state.session.xpEvents.push({ wordId: word.id, exercise: task.type, correct, xp: totalXp });
  state.profile.totalXp = (state.profile.totalXp || 0) + totalXp;
  updateStreak();

  await Promise.all([putOne('words', word), putOne('profile', state.profile)]);
  state.words = state.words.map((item) => item.id === word.id ? { ...word } : item);

  const newLevel = levelData(state.profile.totalXp || 0).level;
  if (newLevel > oldLevel) showToast(`Новый уровень: ${newLevel}! 🎉`);
  renderStudy();
}

function updateWordMemory(word, correct, exerciseType) {
  const now = Date.now();
  word.seenCount = Number(word.seenCount || 0) + 1;
  word.introducedAt ||= new Date(now).toISOString();
  let stability = Math.max(0.35, Number(word.stabilityDays || word.intervalDays || 0.35));
  let difficulty = Math.min(1, Math.max(0.1, Number(word.difficulty || 0.5)));
  let earned = 0;

  if (!correct) {
    word.wrongCount = Number(word.wrongCount || 0) + 1;
    word.lapses = Number(word.lapses || 0) + 1;
    word.consecutiveCorrect = 0;
    difficulty = Math.min(1, difficulty + 0.09);
    stability = Math.max(0.2, stability * 0.42);
    const relearnHours = word.seenCount <= 3 ? 3 : 8;
    word.nextReviewAt = new Date(now + relearnHours * 3_600_000).toISOString();
  } else {
    word.correctCount = Number(word.correctCount || 0) + 1;
    word.consecutiveCorrect = Number(word.consecutiveCorrect || 0) + 1;
    const strength = { choice: 1.65, reverse: 1.9, listening: 1.85, typing: 2.35, context: 2.15 }[exerciseType] || 1.7;
    const streakBonus = 1 + Math.min(0.35, word.consecutiveCorrect * 0.06);
    stability = Math.min(365, Math.max(0.8, stability * strength * streakBonus));
    difficulty = Math.max(0.1, difficulty - 0.035);
    const fuzz = 0.92 + Math.random() * 0.16;
    word.nextReviewAt = new Date(now + stability * fuzz * DAY).toISOString();
    earned = { choice: 1, reverse: 2, listening: 2, typing: 3, context: 3 }[exerciseType] || 1;
  }

  word.stabilityDays = stability;
  word.intervalDays = stability;
  word.difficulty = difficulty;
  word.mastery = calculateMastery(word);
  if (word.seenCount === 0) word.status = 'new';
  else if (word.lapses >= 2 && word.mastery < 0.58) word.status = 'difficult';
  else if (word.mastery >= 0.72 && stability >= 7 && word.consecutiveCorrect >= 2) word.status = 'learned';
  else word.status = 'learning';
  return earned;
}

function calculateMastery(word) {
  const correct = Number(word.correctCount || 0);
  const wrong = Number(word.wrongCount || 0);
  const attempts = correct + wrong;
  if (!attempts) return 0;
  const accuracy = correct / attempts;
  const stability = Math.max(0, Number(word.stabilityDays || word.intervalDays || 0));
  const intervalScore = Math.min(1, Math.log2(stability + 1) / 5);
  const streakScore = Math.min(1, Number(word.consecutiveCorrect || 0) / 4);
  return Math.max(0, Math.min(1, accuracy * 0.52 + intervalScore * 0.33 + streakScore * 0.15));
}

async function advanceStudyTask() {
  const task = currentStudyTask();
  if (!task?.answered) return;
  state.session.index += 1;
  if (state.session.index >= state.session.tasks.length) await completeSession();
  renderStudy();
}

async function ensureSmartNewWords(maxCount) {
  if (!state.settings.smartNewWords || maxCount <= 0) return;
  const today = todayKey();
  const addedToday = state.words.filter((word) => word.source === 'library-auto' && word.createdAt?.startsWith(today)).length;
  const backlog = state.words.filter((word) => Number(word.seenCount || 0) === 0 || word.status === 'new').length;
  const allowance = Math.max(0, Number(state.settings.newWordsPerDay || 5) - addedToday);
  const count = Math.min(maxCount, allowance, Math.max(0, 6 - backlog));
  if (!count) return;

  const existing = new Set(state.words.map((word) => word.term.trim().toLowerCase()));
  const candidates = LIBRARY_WORDS.filter((word) => !existing.has(word.term.toLowerCase()) && levelAllowed(word.level));
  const picked = pickVariedNewWords(candidates, count);
  const now = new Date().toISOString();
  for (const source of picked) {
    const word = normalizeWord({
      ...source,
      id: uid(),
      libraryId: source.id,
      category: source.topic,
      status: 'new',
      source: 'library-auto',
      createdAt: now,
      updatedAt: now,
      nextReviewAt: now,
      syncState: 'pending'
    });
    await putOne('words', word);
    state.words.unshift(word);
  }
}

function levelAllowed(level) {
  const setting = state.settings.learningLevel || 'A1-B1';
  if (setting === 'ALL') return true;
  if (setting === 'A1-A2') return ['A1', 'A2'].includes(level);
  if (setting === 'B1-B2') return ['B1', 'B2'].includes(level);
  return ['A1', 'A2', 'B1'].includes(level);
}

function pickVariedNewWords(candidates, count) {
  const levelRank = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5 };
  const ordered = [...candidates].sort((a, b) => (levelRank[a.level] || 9) - (levelRank[b.level] || 9) || Math.random() - 0.5);
  const result = [];
  const topics = new Set();
  for (const word of ordered) {
    if (!topics.has(word.topic)) {
      result.push(word);
      topics.add(word.topic);
    }
    if (result.length >= count) break;
  }
  if (result.length < count) {
    for (const word of ordered) {
      if (!result.some((item) => item.id === word.id)) result.push(word);
      if (result.length >= count) break;
    }
  }
  return result;
}

function updateStreak() {
  const today = todayKey();
  if (state.profile.lastActiveDate === today) return;
  const yesterday = todayKey(new Date(Date.now() - DAY));
  state.profile.streak = state.profile.lastActiveDate === yesterday ? (state.profile.streak || 0) + 1 : 1;
  state.profile.lastActiveDate = today;
}

async function completeSession() {
  if (!state.session || state.session.finished) return;
  state.session.xp += 15;
  state.profile.totalXp = (state.profile.totalXp || 0) + 15;
  state.session.finished = true;
  state.session.completedAt = new Date().toISOString();

  const stored = {
    id: state.session.id,
    startedAt: state.session.startedAt,
    completedAt: state.session.completedAt,
    reviewed: state.session.answered,
    uniqueWords: state.session.words.length,
    correct: state.session.correct,
    mistakes: state.session.mistakes,
    xp: state.session.xp,
    wordIds: state.session.words.map((word) => word.id),
    xpEvents: state.session.xpEvents,
    syncState: 'pending'
  };
  state.sessions.push(stored);
  await Promise.all([putOne('sessions', stored), putOne('profile', state.profile)]);
}

function renderSessionResult() {
  const attempts = Math.max(1, state.session.correct + state.session.mistakes);
  const accuracy = Math.round((state.session.correct / attempts) * 100);
  const level = levelData(state.profile.totalXp || 0);
  const repeats = Math.max(0, state.session.tasks.length - state.session.words.length);
  view.innerHTML = `
    <section class="result-card">
      <div class="result-icon">✓</div>
      <span class="eyebrow">Занятие завершено</span>
      <h1>${accuracy >= 85 ? 'Сильно!' : accuracy >= 65 ? 'Хороший подход!' : 'Вот где растёт память!'}</h1>
      <p>${state.session.mistakes ? 'Ошибки уже отправлены на более раннее повторение — именно они помогут следующему занятию стать точнее.' : 'Без ошибок. Следующие интервалы увеличены, поэтому эти слова не будут надоедать слишком часто.'}</p>
      <div class="result-stats"><span><strong>${state.session.words.length}</strong><small>разных слов</small></span><span><strong>${accuracy}%</strong><small>точность</small></span><span><strong>+${state.session.xp}</strong><small>XP</small></span></div>
      ${repeats ? `<div class="smart-result-note">↻ Дополнительных закреплений в занятии: <strong>${repeats}</strong></div>` : ''}
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
      <div><span class="eyebrow">Профиль</span><h1>${escapeHtml(state.profile.displayName)}</h1><p>Локальный режим · данные хранятся на этом устройстве</p></div>
      <span class="profile-level">${level.rank.icon} ${level.level}</span>
    </section>

    <section class="settings-panel">
      <h2>Умное обучение</h2>
      ${settingToggle('Автоподбор новых слов', 'Добавлять новые слова из библиотеки небольшими порциями', 'smartNewWords', state.settings.smartNewWords)}
      ${settingSelectText('Уровень новых слов', 'Какую сложность брать из общей библиотеки', 'learningLevel', state.settings.learningLevel, [
        { value: 'A1-A2', label: 'A1–A2 · базовый' },
        { value: 'A1-B1', label: 'A1–B1 · повседневный' },
        { value: 'B1-B2', label: 'B1–B2 · уверенный' },
        { value: 'ALL', label: 'Все уровни' }
      ])}
      ${settingSelect('Новых слов в день', 'Лимит, а не обязательная норма', 'newWordsPerDay', state.settings.newWordsPerDay, [3, 5, 8, 10])}
      ${settingSelect('Длительность занятия', 'Целевое число заданий за подход', 'sessionLength', state.settings.sessionLength, [8, 12, 16, 20])}
      ${settingSelectText('Английский голос', 'Основной вариант произношения', 'voiceLang', state.settings.voiceLang, [{ value: 'en-US', label: 'Американский' }, { value: 'en-GB', label: 'Британский' }])}
      ${settingSelect('Скорость речи', 'Можно замедлить произношение', 'speechRate', state.settings.speechRate, [0.65, 0.8, 0.85, 1])}
      ${settingToggle('Автовоспроизведение', 'Произносить слово в заданиях на слух', 'autoPlay', state.settings.autoPlay)}
    </section>

    <section class="settings-panel">
      <h2>Данные и PWA</h2>
      ${actionSetting('⇧', 'Экспорт данных', 'Сохранить резервную копию в JSON', 'export-data')}
      ${actionSetting('⇩', 'Импорт данных', 'Восстановить словарь и прогресс', 'trigger-import')}
      ${actionSetting('⌂', 'Установить на экран Домой', 'Открывать как отдельное приложение', 'install-app')}
      <input id="importFile" type="file" accept="application/json" hidden>
    </section>

    <section class="version-card"><span>English Vocabulary</span><strong>Версия ${APP_VERSION}</strong><small>Умный микс · интервальные повторения · IndexedDB offline-first</small></section>
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
