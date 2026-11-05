import type { CandidateProfile } from '../shared/types.js';
import { escapeRegex } from './text.js';

/**
 * Skill taxonomy used to detect requirements in job descriptions and to compare them
 * with the verified profile. Canonical ids are stable; aliases are matched case-insensitively
 * on word boundaries.
 */

export interface SkillDef {
  id: string;
  label: string;
  aliases: string[];
  category: 'language' | 'frontend' | 'testing' | 'tooling' | 'backend' | 'cloud' | 'practice' | 'design' | 'ai' | 'ml' | 'data';
  /** Case-sensitive matching (for short names like "C") */
  caseSensitive?: boolean;
}

export const SKILLS: SkillDef[] = [
  // Languages
  { id: 'javascript', label: 'JavaScript', aliases: ['javascript', 'es6', 'es6+', 'ecmascript', 'js'], category: 'language' },
  { id: 'typescript', label: 'TypeScript', aliases: ['typescript'], category: 'language' },
  { id: 'html', label: 'HTML', aliases: ['html', 'html5', 'semantic html'], category: 'language' },
  { id: 'css', label: 'CSS', aliases: ['css', 'css3'], category: 'language' },
  { id: 'python', label: 'Python', aliases: ['python'], category: 'language' },
  { id: 'c', label: 'C', aliases: ['C'], category: 'language', caseSensitive: true },
  { id: 'cpp', label: 'C++', aliases: ['c++'], category: 'language' },
  { id: 'java', label: 'Java', aliases: ['java'], category: 'language' },
  { id: 'go', label: 'Go', aliases: ['golang'], category: 'language' },
  { id: 'sql', label: 'SQL', aliases: ['sql'], category: 'data' },
  { id: 'sass', label: 'Sass/SCSS', aliases: ['sass', 'scss'], category: 'frontend' },
  // Frontend frameworks & libraries
  { id: 'react', label: 'React', aliases: ['react', 'react.js', 'reactjs', 'react js'], category: 'frontend' },
  { id: 'nextjs', label: 'Next.js', aliases: ['next.js', 'nextjs', 'next js'], category: 'frontend' },
  { id: 'react_native', label: 'React Native', aliases: ['react native'], category: 'frontend' },
  { id: 'vue', label: 'Vue', aliases: ['vue', 'vue.js', 'vuejs', 'nuxt'], category: 'frontend' },
  { id: 'angular', label: 'Angular', aliases: ['angular', 'angularjs'], category: 'frontend' },
  { id: 'svelte', label: 'Svelte', aliases: ['svelte', 'sveltekit'], category: 'frontend' },
  { id: 'redux', label: 'Redux', aliases: ['redux', 'redux toolkit', 'rtk query'], category: 'frontend' },
  { id: 'zustand', label: 'Zustand', aliases: ['zustand'], category: 'frontend' },
  { id: 'react_query', label: 'React Query', aliases: ['react query', 'tanstack query', 'tanstack'], category: 'frontend' },
  { id: 'react_hook_form', label: 'React Hook Form', aliases: ['react hook form', 'react-hook-form'], category: 'frontend' },
  { id: 'zod', label: 'Zod', aliases: ['zod'], category: 'frontend' },
  { id: 'tailwind', label: 'Tailwind CSS', aliases: ['tailwind', 'tailwind css', 'tailwindcss'], category: 'frontend' },
  { id: 'mui', label: 'Material UI', aliases: ['material ui', 'material-ui', 'mui'], category: 'frontend' },
  { id: 'styled_components', label: 'styled-components', aliases: ['styled-components', 'styled components', 'css-in-js', 'emotion'], category: 'frontend' },
  { id: 'xyflow', label: 'XYFlow / React Flow', aliases: ['xyflow', 'react flow', 'reactflow'], category: 'frontend' },
  { id: 'd3', label: 'D3', aliases: ['d3', 'd3.js'], category: 'frontend' },
  { id: 'threejs', label: 'Three.js', aliases: ['three.js', 'threejs', 'webgl'], category: 'frontend' },
  { id: 'storybook', label: 'Storybook', aliases: ['storybook'], category: 'frontend' },
  { id: 'design_systems', label: 'Design systems', aliases: ['design system', 'design systems', 'component library', 'component libraries'], category: 'design' },
  { id: 'responsive', label: 'Responsive design', aliases: ['responsive design', 'responsive', 'mobile-first', 'mobile first'], category: 'frontend' },
  { id: 'accessibility', label: 'Accessibility (WCAG)', aliases: ['accessibility', 'accessible', 'a11y', 'wcag', 'aria'], category: 'frontend' },
  { id: 'ui_ux', label: 'UI/UX implementation', aliases: ['ui/ux', 'ux', 'user experience', 'user interface', 'ui implementation'], category: 'design' },
  { id: 'figma', label: 'Figma', aliases: ['figma'], category: 'design' },
  { id: 'performance', label: 'Web performance', aliases: ['web performance', 'performance optimization', 'core web vitals', 'web vitals', 'lighthouse'], category: 'frontend' },
  { id: 'seo', label: 'SEO', aliases: ['seo'], category: 'frontend' },
  { id: 'pwa', label: 'PWA', aliases: ['pwa', 'progressive web app'], category: 'frontend' },
  { id: 'websockets', label: 'WebSockets', aliases: ['websocket', 'websockets', 'socket.io'], category: 'frontend' },
  { id: 'microfrontends', label: 'Micro-frontends', aliases: ['micro-frontend', 'micro-frontends', 'microfrontend', 'module federation'], category: 'frontend' },
  { id: 'i18n', label: 'Internationalization', aliases: ['i18n', 'internationalization', 'localization'], category: 'frontend' },
  // Testing
  { id: 'jest', label: 'Jest', aliases: ['jest'], category: 'testing' },
  { id: 'vitest', label: 'Vitest', aliases: ['vitest'], category: 'testing' },
  { id: 'rtl', label: 'React Testing Library', aliases: ['react testing library', 'testing library'], category: 'testing' },
  { id: 'playwright', label: 'Playwright', aliases: ['playwright'], category: 'testing' },
  { id: 'cypress', label: 'Cypress', aliases: ['cypress'], category: 'testing' },
  { id: 'axe', label: 'axe-core', aliases: ['axe-core', 'axe core'], category: 'testing' },
  { id: 'unit_testing', label: 'Automated testing', aliases: ['unit test', 'unit tests', 'unit testing', 'end-to-end', 'e2e', 'test automation', 'automated tests', 'automated testing'], category: 'testing' },
  // Tooling
  { id: 'git', label: 'Git', aliases: ['git'], category: 'tooling' },
  { id: 'github', label: 'GitHub', aliases: ['github'], category: 'tooling' },
  { id: 'ci_cd', label: 'CI/CD', aliases: ['ci/cd', 'github actions', 'continuous integration', 'ci pipeline', 'ci pipelines'], category: 'tooling' },
  { id: 'vite', label: 'Vite', aliases: ['vite'], category: 'tooling' },
  { id: 'webpack', label: 'Webpack', aliases: ['webpack', 'babel', 'rollup', 'esbuild'], category: 'tooling' },
  { id: 'devtools', label: 'Chrome DevTools', aliases: ['chrome devtools', 'devtools'], category: 'tooling' },
  { id: 'vscode', label: 'VS Code', aliases: ['vs code', 'vscode'], category: 'tooling' },
  { id: 'npm', label: 'npm', aliases: ['npm', 'yarn', 'pnpm'], category: 'tooling' },
  // Backend / cloud
  { id: 'rest', label: 'REST APIs', aliases: ['rest', 'rest api', 'rest apis', 'restful', 'api integration', 'apis'], category: 'backend' },
  { id: 'graphql', label: 'GraphQL', aliases: ['graphql', 'apollo'], category: 'backend' },
  { id: 'nodejs', label: 'Node.js', aliases: ['node.js', 'nodejs', 'node js'], category: 'backend' },
  { id: 'express', label: 'Express', aliases: ['express', 'express.js', 'expressjs'], category: 'backend' },
  { id: 'mongodb', label: 'MongoDB', aliases: ['mongodb', 'mongo'], category: 'backend' },
  { id: 'postgres', label: 'PostgreSQL', aliases: ['postgresql', 'postgres'], category: 'backend' },
  { id: 'firebase', label: 'Firebase', aliases: ['firebase'], category: 'backend' },
  { id: 'docker', label: 'Docker', aliases: ['docker'], category: 'cloud' },
  { id: 'kubernetes', label: 'Kubernetes', aliases: ['kubernetes', 'k8s'], category: 'cloud' },
  { id: 'aws', label: 'AWS', aliases: ['aws', 'amazon web services'], category: 'cloud' },
  { id: 'gcp', label: 'Google Cloud', aliases: ['gcp', 'google cloud'], category: 'cloud' },
  { id: 'azure', label: 'Azure', aliases: ['azure'], category: 'cloud' },
  // Practices
  { id: 'agile', label: 'Agile/Scrum', aliases: ['agile', 'scrum', 'kanban', 'sprint'], category: 'practice' },
  // AI application development & prompting
  { id: 'prompt_engineering', label: 'Prompt engineering', aliases: ['prompt engineering', 'prompt design', 'prompting', 'prompt writing', 'prompt engineer'], category: 'ai' },
  { id: 'llm', label: 'LLMs', aliases: ['llm', 'llms', 'large language model', 'large language models'], category: 'ai' },
  { id: 'genai', label: 'Generative AI', aliases: ['generative ai', 'genai', 'gen ai', 'gen-ai'], category: 'ai' },
  { id: 'openai_api', label: 'OpenAI API', aliases: ['openai', 'gpt-4', 'gpt-4o', 'chatgpt', 'gpt'], category: 'ai' },
  { id: 'claude_api', label: 'Claude / Anthropic API', aliases: ['anthropic', 'claude'], category: 'ai' },
  { id: 'gemini_api', label: 'Gemini API', aliases: ['gemini'], category: 'ai' },
  { id: 'langchain', label: 'LangChain', aliases: ['langchain', 'langgraph'], category: 'ai' },
  { id: 'llamaindex', label: 'LlamaIndex', aliases: ['llamaindex', 'llama index'], category: 'ai' },
  { id: 'rag', label: 'RAG', aliases: ['rag', 'retrieval augmented generation', 'retrieval-augmented generation'], category: 'ai' },
  { id: 'vector_db', label: 'Vector databases', aliases: ['vector database', 'vector databases', 'pinecone', 'weaviate', 'chroma', 'pgvector', 'faiss'], category: 'ai' },
  { id: 'embeddings', label: 'Embeddings', aliases: ['embeddings', 'embedding'], category: 'ai' },
  { id: 'ai_agents', label: 'AI agents', aliases: ['ai agents', 'agentic', 'tool calling', 'function calling'], category: 'ai' },
  { id: 'evals', label: 'LLM evaluation', aliases: ['evals', 'llm evaluation', 'model evaluation', 'red teaming'], category: 'ai' },
  { id: 'chatbots', label: 'Chatbots', aliases: ['chatbot', 'chatbots', 'conversational ai'], category: 'ai' },
  { id: 'nlp', label: 'NLP', aliases: ['nlp', 'natural language processing'], category: 'ml' },
  // ML research (used to detect roles that need a research/ML background)
  { id: 'machine_learning', label: 'Machine learning', aliases: ['machine learning', 'ml models', 'ml engineering'], category: 'ml' },
  { id: 'deep_learning', label: 'Deep learning', aliases: ['deep learning', 'neural networks', 'neural network'], category: 'ml' },
  { id: 'pytorch', label: 'PyTorch', aliases: ['pytorch'], category: 'ml' },
  { id: 'tensorflow', label: 'TensorFlow', aliases: ['tensorflow', 'keras'], category: 'ml' },
  { id: 'fine_tuning', label: 'Model fine-tuning', aliases: ['fine-tuning', 'fine tuning', 'finetuning', 'rlhf', 'lora'], category: 'ml' },
  { id: 'computer_vision', label: 'Computer vision', aliases: ['computer vision', 'opencv'], category: 'ml' },
  { id: 'statistics', label: 'Statistics', aliases: ['statistics', 'statistical modeling'], category: 'ml' },
  { id: 'huggingface', label: 'Hugging Face', aliases: ['hugging face', 'huggingface', 'transformers library'], category: 'ml' },
];

const BY_ID = new Map(SKILLS.map((s) => [s.id, s]));

interface Matcher {
  id: string;
  re: RegExp;
}

const MATCHERS: Matcher[] = SKILLS.flatMap((s) =>
  s.aliases.map((alias) => {
    const body = escapeRegex(alias);
    // Word-ish boundaries that also work for aliases ending in symbols (c++, ci/cd, react.js).
    const pattern = s.id === 'c' ? `(?<![\\w+#-])C(?![\\w+#-])` : `(?<![\\w.+#/-])${body}(?![\\w+#/-]|\\.\\w)`;
    return { id: s.id, re: new RegExp(pattern, s.caseSensitive ? 'g' : 'gi') };
  }),
);

/** Ambiguous aliases that only count when another frontend signal is present. */
const WEAK_ALIASES: Record<string, RegExp> = {
  go: /\bgolang\b/i,
  rest: /\brest(ful)?\b|\bapi/i,
};

export function skillLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

export function skillCategory(id: string): SkillDef['category'] | undefined {
  return BY_ID.get(id)?.category;
}

/** Find canonical skill ids mentioned in free text. */
export function findSkills(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const m of MATCHERS) {
    m.re.lastIndex = 0;
    if (m.re.test(text)) found.add(m.id);
  }
  // "Java" inside "JavaScript" is prevented by boundaries; avoid "Go" false positives etc.
  for (const [id, re] of Object.entries(WEAK_ALIASES)) if (found.has(id) && !re.test(text)) found.delete(id);
  return [...found];
}

/** Map a single skill string from the resume (e.g. "React.js") to a canonical id, if known. */
export function canonicalSkill(raw: string): string | null {
  const hits = findSkills(raw);
  if (hits.length === 0) return null;
  // Prefer the most specific (longest alias) match
  const lower = raw.toLowerCase();
  let best: string | null = null;
  let bestLen = -1;
  for (const id of hits) {
    const def = BY_ID.get(id)!;
    for (const a of def.aliases) {
      if (lower.includes(a.toLowerCase()) && a.length > bestLen) {
        best = id;
        bestLen = a.length;
      }
    }
  }
  return best ?? hits[0];
}

/**
 * Every skill the candidate verifiably has: explicit skill lists, project technologies and
 * tools named in bullets/summary of the verified profile.
 */
export function candidateSkillIds(profile: CandidateProfile): Set<string> {
  const ids = new Set<string>();
  const texts: string[] = [profile.summary, profile.headline];
  for (const g of profile.skillGroups) for (const s of g.skills) texts.push(s);
  for (const p of profile.projects) {
    texts.push(...p.technologies, p.name, p.subtitle ?? '');
    texts.push(...p.bullets.map((b) => b.text));
  }
  for (const e of profile.experience) texts.push(e.title, ...e.bullets.map((b) => b.text));
  for (const c of profile.certifications) texts.push(c.name);
  for (const t of texts) for (const id of findSkills(t)) ids.add(id);
  // Implied: TypeScript and React imply JavaScript knowledge
  if (ids.has('typescript') || ids.has('react')) ids.add('javascript');
  if (ids.has('github')) ids.add('git');
  return ids;
}
