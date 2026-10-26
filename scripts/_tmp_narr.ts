import { getAppSettings, loadRootEnv } from '@clipper/shared/server';
import { addNarrator } from '../apps/web/worker/narrator';
loadRootEnv();
const t = await addNarrator({
  video: 'C:/Users/joaob/AppData/Local/Temp/claude/D--trabalho-videos/32092a74-4d09-48ac-9db8-26521be60c86/scratchpad/narr/in.mp4',
  idea: { id: 'x', template: 'voce_sabia', title: 't', hook: 'Você sabia que existem 5 vulcões prestes a acordar?', script: 'Você sabia que existem pelo menos cinco vulcões que podem entrar em erupção a qualquer momento? Um deles fica nos Estados Unidos e é tão grande que seria visto do espaço. Os cientistas monitoram cada tremor. Comenta aqui qual vulcão você acha que é!', cta: 'Comenta qual vulcão você acha que é!', segments: [{ start: 0, end: 10 }], score: 90, reason: '', hashtags: [] },
  width: 1080, height: 1920, app: getAppSettings(), workDir: 'C:/Users/joaob/AppData/Local/Temp/claude/D--trabalho-videos/32092a74-4d09-48ac-9db8-26521be60c86/scratchpad/narr/work', log: (l, m) => console.log(l, m),
});
console.log('total', t);
