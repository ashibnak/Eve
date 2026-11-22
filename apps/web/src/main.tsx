import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { currentLocale, localeInfo, t } from './i18n/t';
import './styles/app.css';

document.documentElement.lang = currentLocale;
document.documentElement.dir = localeInfo[currentLocale].dir;
document.title = t('app.title');

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
