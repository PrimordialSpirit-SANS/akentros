import type React from "react";

export interface AkentrosIconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
}

/**
 * Akentros 品牌向量圖標:信號燈塔(基座 + 光點 + 兩道廣播弧線)。
 * 以 currentColor 描繪,跟隨文字顏色。
 */
export const AkentrosIcon: React.FC<AkentrosIconProps> = ({ size = 40, className, ...props }) => {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {/* 基座 */}
      <path d="M12 21v-3.2" />
      {/* 光點 */}
      <circle cx="12" cy="14.6" r="2.1" fill="currentColor" stroke="none" />
      {/* 內弧 */}
      <path d="M7.6 10.9a6.2 6.2 0 0 1 8.8 0" />
      {/* 外弧 */}
      <path d="M4.8 8a10.2 10.2 0 0 1 14.4 0" />
    </svg>
  );
};

export default AkentrosIcon;
