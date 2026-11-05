import React, { useEffect, useState } from 'react'
import { Monitor } from 'lucide-react'
import { useT } from '../utils/useUiLang'

interface DisplayInfo {
  id: number
  label: string
  width: number
  height: number
  primary: boolean
  current: boolean
}

/** Which monitor she lives on, and whether she may do things on her own when she's bored */
export const BehaviorSettings: React.FC = () => {
  const t = useT()
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [boredom, setBoredom] = useState(true)
  const [wander, setWander] = useState(true)

  const load = () => window.api.companion.listDisplays().then(setDisplays).catch(() => {})

  useEffect(() => {
    void load()
    window.api.boredom.getEnabled().then(setBoredom).catch(() => {})
    window.api.companion.getMonitorWander().then(setWander).catch(() => {})
  }, [])

  const current = displays.find((d) => d.current)

  return (
    <div className="p-3 bg-black/60 border border-stone-800 space-y-3">
      <label className="block text-[13px] text-stone-300">
        <span className="font-semibold text-[14px] flex items-center gap-1.5 mb-1.5">
          <Monitor size={14} className="text-cp-400" /> {t('vs_monitor')}
        </span>
        <select
          value={current?.id ?? ''}
          disabled={displays.length < 2}
          onChange={(e) => {
            void window.api.companion.moveToDisplay(Number(e.target.value)).then(load)
          }}
          className="w-full bg-black border border-stone-700 text-stone-200 px-2 py-1.5 text-[13px] disabled:opacity-60"
        >
          {displays.map((d, i) => (
            <option key={d.id} value={d.id}>
              {i + 1}. {d.label || t('vs_monitor')} ({d.width}x{d.height}){d.primary ? ` - ${t('vs_monitorMain')}` : ''}
            </option>
          ))}
        </select>
      </label>
      {displays.length > 1 && (
        <label className="flex items-center gap-2 text-[13px] text-stone-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={wander}
            onChange={(e) => {
              setWander(e.target.checked)
              void window.api.companion.setMonitorWander(e.target.checked)
            }}
          />
          {t('vs_wander')}
        </label>
      )}
      <label className="flex items-center gap-2 text-[13px] text-stone-300 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={boredom}
          onChange={(e) => {
            setBoredom(e.target.checked)
            void window.api.boredom.setEnabled(e.target.checked)
          }}
        />
        {t('vs_boredom')}
      </label>
    </div>
  )
}
