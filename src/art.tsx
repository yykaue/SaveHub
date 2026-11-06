import { Circle, Flame, Gamepad2, Gem, Ghost, Rocket, Swords, TowerControl } from 'lucide-react';
import { useId } from 'react';
import logoUrl from '../build/icon.svg';

/** 应用品牌图标组件 */
export function Logo({ small = false }: { small?: boolean }) {
  return (
    <img
      className="savehub-logo"
      src={logoUrl}
      width={small ? 27 : 35}
      height={small ? 27 : 35}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

/** 游戏图标渲染组件：支持自定义 Base64 / savehub-icon:// 协议图片或内置 Lucide 矢量图标 */
export function GameGlyph({ icon, size = 23 }: { icon: string; size?: number }) {
  if (icon.startsWith('data:image/') || icon.startsWith('savehub-icon://'))
    return <img src={icon} alt="" className="custom-icon" width={size} height={size} loading="lazy" />;
  const Icon =
    (
      {
        ring: Circle,
        spire: TowerControl,
        flame: Flame,
        gamepad: Gamepad2,
        swords: Swords,
        gem: Gem,
        ghost: Ghost,
        rocket: Rocket,
      } as const
    )[icon as 'ring'] || Gamepad2;
  return <Icon size={size} strokeWidth={1.5} />;
}

/** 详情页顶部主题风景插画 SVG 组件 */
export function Landscape({ kind = 'ring', className = '' }: { kind?: string; className?: string }) {
  const unique = useId().replaceAll(':', '');
  return (
    <svg
      className={`landscape ${className}`}
      viewBox="0 0 840 340"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`${unique}sky`} x2="0" y2="1">
          <stop stopColor="var(--art-sky)" />
          <stop offset="1" stopColor="var(--art-ground)" />
        </linearGradient>
        <linearGradient id={`${unique}mist`} x2="0" y2="1">
          <stop stopColor="var(--art-mist)" stopOpacity="0" />
          <stop offset="1" stopColor="var(--art-mist)" stopOpacity=".95" />
        </linearGradient>
        <radialGradient id={`${unique}sun`}>
          <stop stopColor="var(--art-sun)" stopOpacity=".65" />
          <stop offset="1" stopColor="var(--art-sun)" stopOpacity="0" />
        </radialGradient>
        <filter id={`${unique}blur`}>
          <feGaussianBlur stdDeviation="11" />
        </filter>
      </defs>
      <rect width="840" height="340" fill={`url(#${unique}sky)`} />
      <circle cx="593" cy="132" r="155" fill={`url(#${unique}sun)`} />
      <circle cx="594" cy="120" r="65" fill="none" stroke="var(--art-sun)" strokeWidth="1.5" opacity=".6" />
      <circle cx="594" cy="120" r="60" fill="none" stroke="var(--art-sun)" strokeWidth=".5" opacity=".35" />
      <path
        className="mountain-layer"
        d="M0 237Q38 214 60 194Q81 206 108 215Q156 159 185 139Q202 155 235 178Q261 166 285 158Q310 188 326 204Q360 185 385 165Q403 171 422 181Q451 144 469 126Q493 166 530 188Q546 174 560 166Q593 196 625 203Q661 161 680 137Q707 173 740 193Q774 164 790 157Q817 189 840 206V340H0Z"
        fill="var(--art-far)"
        opacity=".38"
      />
      <path
        className="mountain-layer"
        d="M0 270Q52 254 83 230Q99 236 117 247Q143 222 168 211Q193 241 219 257Q254 225 281 211Q308 227 332 246Q370 224 400 210Q437 222 465 242Q496 214 525 201Q550 216 579 227Q613 210 635 199Q669 227 692 244Q718 221 742 203Q767 223 788 233Q814 223 840 211V340H0Z"
        fill="var(--art-far)"
        opacity=".55"
      />
      <ellipse cx="510" cy="269" rx="390" ry="34" fill="var(--art-mist)" opacity=".7" filter={`url(#${unique}blur)`} />
      {kind === 'spire' ? (
        <g fill="var(--art-ink)" opacity=".72">
          <path d="m580 251 9-111 10-6 2-64 9-32 9 32 2 64 10 6 9 111Z" />
          <path d="M565 251h90l-11-30h-69ZM578 172h65l-8-15h-49ZM591 118h40l-7-11h-26Z" />
          <path d="m580 251-26 22h116l-26-22Z" />
        </g>
      ) : kind === 'flame' ? (
        <g fill="var(--art-ink)" opacity=".76">
          <path d="M502 274v-70h14v-20h12v20h15v-41h14v-17h12v17h13v75h22v-59h14v-18h12v18h13v-54h17v-20h13v20h16v129Z" />
          <path d="M628 130h74l-37-51ZM541 168h43l-22-35Z" />
          <path d="m500 271-25 28h242l-28-28Z" />
        </g>
      ) : (
        <g fill="none" stroke="var(--art-ink)" strokeLinecap="round" strokeLinejoin="round" opacity=".76">
          <path d="M592 282c8-32 10-57 7-88-4-34-1-65 7-92" strokeWidth="10" />
          <path
            d="M598 214c-24-32-41-49-79-60M601 191c21-32 50-43 78-48M603 165c-19-26-41-45-65-52M604 147c27-22 43-34 60-62M603 120c-10-17-15-31-13-49"
            strokeWidth="5"
          />
          <path
            d="m520 154-26-7-17-19m43 26-1-25-12-14m35 51-15 9-26-2m96 30-32-15-8-24m93-14 25 10 28-11m-32-5 5-26 23-15m-80 70 19 3 17-10m-53-45-6-20-20-15m22 22-25 2-16-10m96-23 23-3 15-18m-27 15-3-20 7-16m-33 56 5-28-13-20m-26 23-16-13-2-19m15 15 16-14 2-17"
            strokeWidth="2.3"
          />
          <path d="m593 279-32 10m34-8 21 7m-21-10-14 5" strokeWidth="4" />
          <path
            d="m489 130-19-4m49 3 7-13m-17-3-11-9m25 73-12 6m193-37 18-11m-30-29 15 1m-14-41 8-12m-106-1-6-14m-15 26-10-8m63-15 2-13"
            strokeWidth="1"
          />
        </g>
      )}
      <path
        d="M0 321 90 301l64 9 78-28 66 25 88-9 70 8 81-32 51 3 31-5 47 17 64-18 50 19 60-16v66H0Z"
        fill="var(--art-near)"
        opacity=".6"
      />
      <rect y="241" width="840" height="99" fill={`url(#${unique}mist)`} />
      <g fill="none" stroke="var(--art-ink)" opacity=".25" strokeWidth="1">
        <path d="m397 83 7-3 7 3m28 18 5-2 5 2m-107 20 6-2 6 2" />
      </g>
    </svg>
  );
}
