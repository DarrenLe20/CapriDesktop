/**
 * Guesses the language of a message from its alphabet, its letters and its most typical words.
 * When the evidence is thin or tied it says so ('unknown') instead of guessing: a wrong guess makes
 * Capri answer in a language nobody spoke to her in. Words shared between languages ("no", "la",
 * "de", "mi") are left out on purpose, because they decide nothing.
 *
 * It still tells other languages apart, so their words don't count as Spanish or English and a
 * model reply in the wrong language gets noticed, but she only answers in en, es and ja.
 */

import { isSupportedLang } from '../../shared/languages'

export type DetectedLang = 'es' | 'en' | 'pt' | 'fr' | 'de' | 'it' | 'pl' | 'ru' | 'ja' | 'ko' | 'zh' | 'unknown'

type LatinLang = 'es' | 'en' | 'pt' | 'fr' | 'de' | 'it' | 'pl'

const WORDS: Record<LatinLang, string> = {
  es: `hola buenas que qué como cómo estas estás esto estos quien quién sos eres hacer hace haceme hacé puedes podes podés
    cambia cambiar cancion canción reproduce reproducir pon pone poné poneme busca buscar abrir abre abrí cierra cerrar cerrá borra
    borrar pantalla viendo escuchando sabes sabés gusta conoces conocés donde dónde cuantas cuántas cuanto cuánto veces gracias
    adios adiós chau dale bueno sentate sientate arriba abajo izquierda derecha tarea escritorio crea creame modifica resolvé
    resuelve mirá che posta zarpado copado vos dibuja dibujá dibujar dibujo dibujame perro gato arbol árbol monigote carita corazon
    corazón el los las unos unas del por para pero porque también tambien despues después muy mucho más quiero pensá listo lista
    tenés tienes soy estoy somos hay ahora aprendé aprende mostrame mostrá dame dime decime pasame ayudame juegos juego cada uno`,
  en: `the you your what why how where when who are was were can could will would should have has does did create make open
    close play song file desktop homework scan look see tell give with this that from for please about stop change switch language
    draw sketch paint dog cat house sun heart hello hi hey good morning night bye goodbye thanks thank and but not my me i'm it's
    don't there here want need think know like just do is show`,
  pt: `você voce voces vocês não nao tudo obrigado obrigada estou fazer fazendo fala falar falando beleza valeu muito muita
    muitos muitas pra pro pras pros meu minha meus minhas seu sua seus suas dele dela deles delas olá ola ajuda ajudar fechar fecha
    arquivo pasta tarefa lição licao computador tela jogo jogar então entao também tambem demais agora cadê cade comigo pode podem
    consegue pesquisa pesquisar desse dessa disso daqui vamos bora deixa olha mim está gente tá né isso uma procura foto oi com hoje quero tenho sei sim eu ele ela nós bem
    conversar brasil brasileiro português portugues`,
  fr: `bonjour salut merci pourquoi avec je vous nous est les des une dans pour pas oui comment quoi ça suis peux faire ouvre
    mets moi toi mon ma mes ton ta tes sur chanson ferme joue cherche dessine êtes c'est j'ai tu ai as sont être aussi très`,
  de: `hallo danke guten morgen nicht bitte wie ich du und der das ist ein eine mir mach öffne kannst wir sie auf für warum
    spiele schließe lied musik suche zeichne bist hast ja nein wer wo gut sehr auch mein dein zu mit`,
  it: `ciao grazie sono della perché non gli questo questa come voglio puoi fare anche molto bene sei hai amico ora chi cosa
    apri chiudi canzone suona cerca disegna buongiorno buonasera sì mio tuo per dove quando`,
  pl: `cześć czesc dzień dzien dobry dziękuję dziekuje proszę prosze jak się sie nie tak czy jest mam mnie ja ty dlaczego
    gdzie kiedy otwórz otworz zagraj włącz wlacz możesz mozesz jesteś jestes masz dobrze bardzo chcę chce muszę musze kim co
    piosenkę piosenke zamknij szukaj narysuj witaj hej mówisz mowisz mów mow powiedz`
}

const LEXICON = Object.fromEntries(
  (Object.keys(WORDS) as LatinLang[]).map((lang) => [lang, new Set(WORDS[lang].split(/\s+/))])
) as Record<LatinLang, Set<string>>

/** Letters that point at one language. "ó" and "é" are not here: half of Europe uses them */
const LETTERS: [LatinLang, RegExp][] = [
  ['es', /[ñ¿¡]/],
  ['pt', /[ãõ]/],
  ['fr', /[œçèùîûë]/],
  ['de', /[ßäö]/],
  ['pl', /[ąćęłńśźż]/]
]

export interface LanguageScore {
  lang: DetectedLang
  /** How many words and letters point at it */
  score: number
}

export function scoreLanguage(text: string): LanguageScore {
  const clean = text.toLowerCase().trim()
  if (/[぀-ヿ]/.test(clean)) return { lang: 'ja', score: 9 }
  if (/[가-힯ᄀ-ᇿ]/.test(clean)) return { lang: 'ko', score: 9 }
  if (/[一-鿿]/.test(clean)) return { lang: 'zh', score: 9 }
  if (/[Ѐ-ӿ]/.test(clean)) return { lang: 'ru', score: 9 }

  const scores = {} as Record<LatinLang, number>
  const tokens = clean.split(/[^\p{L}']+/u).filter(Boolean)
  for (const lang of Object.keys(LEXICON) as LatinLang[]) {
    scores[lang] = tokens.reduce((sum, token) => sum + (LEXICON[lang].has(token) ? 1 : 0), 0)
  }
  for (const [lang, letters] of LETTERS) {
    if (letters.test(clean)) scores[lang] += 2
  }

  const ranked = (Object.entries(scores) as [LatinLang, number][]).sort((a, b) => b[1] - a[1])
  const [best, second] = ranked
  if (best[1] === 0 || best[1] === second[1]) return { lang: 'unknown', score: 0 }
  return { lang: best[0], score: best[1] - second[1] }
}

/** Only the languages she speaks: a message in any other one tells nothing ('unknown') */
export function detectLanguage(text: string): DetectedLang {
  const { lang } = scoreLanguage(text)
  return isSupportedLang(lang) ? lang : 'unknown'
}

/** The language of a text only when the evidence leaves no doubt, to tell the model it got it wrong */
export function clearLanguageOf(text: string): DetectedLang | null {
  const { lang, score } = scoreLanguage(text)
  return lang !== 'unknown' && score >= 3 ? lang : null
}
