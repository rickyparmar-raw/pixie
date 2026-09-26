"""Regenerates app/_components/PixelIcons.tsx from the "1-bit Pixel Icons" pack.
Each 16x16 sprite's black outline pixels become 1x1 SVG cells drawn in
currentColor; the white fill is dropped so icons read on the dark UI. The file
is shared: app/wizard/_components/PixelIcons.tsx re-exports it, and
app/_components/icons.tsx wraps the components in the dashboard's Icon* names.

Usage: python3 scripts/gen-pixel-icons.py <path-to-pack>/Sprites
Add or change an icon by editing ICON_GROUPS below and re-running.
"""
import sys
from pathlib import Path

from PIL import Image

ONBOARDING_ICONS = {
    # Stepper
    "PixelIconProgram": "Controller_Buttons_Menu_Options_Settings",
    "PixelIconChannels": "Software_Speech_Bubble_Three_Dots_Dialogue",
    "PixelIconDocs": "Software_File_Document_Page_Text_Word",
    "PixelIconHelpers": "Travel_Person_Player_Character_Three_People_Multiplayer",
    "PixelIconLaunch": "Software_Email_Message_Send_Paper_Plane",
    # Doc sources (Docs step source cards + "What Pixie will know" preview)
    "PixelIconNotion": "Software_Notepad_Wordpad_Text_Editor",
    "PixelIconGitHub": "Platforms_GitHub",
    "PixelIconGoogleDoc": "Software_File_Document_Page_Text_Word",
    "PixelIconMarkdown": "Software_Internet_Upload_from_Disk",
    # Step content
    "PixelIconDropFile": "Software_File_Document_Page_Plus_Add_New",
    "PixelIconStorage": "Software_Storage_Drives_Discs_Disks_Server_1",
    "PixelIconMonitor": "Software_Hardware_Monitor_Display_PC_Computer",
    "PixelIconSparkle": "RPG_Magic_Sparkles_Enchantment",
    "PixelIconCheck": "Software_Checkbox_Checkmarked_Yes_Done_Todo",
    "PixelIconWarning": "Software_Warning_Sign_Triangle_Exclaimation_Mark_Error",
    "PixelIconClock": "Software_Clock_Time_Wait_2",
    "PixelIconInfo": "Software_Warning_Sign_Circle_Information_Help",
    "PixelIconLock": "Tools_Crafting_Padlock_Locked",
    "PixelIconClipboard": "Software_Clipbaord_List_File_Copy_Paste",
    "PixelIconClose": "Software_Signs_Maths_Multiplication_X_Crossout_Checkmark_Cancel",
    "PixelIconArrowLeft": "Arrows_Left_West",
    "PixelIconArrowRight": "Arrows_Right_East",
}

# Dashboard shell, nav and cards. Five of these (Check, Sparkle, Clock, Info,
# ArrowRight) already have an onboarding entry for the same sprite, so the merge
# below collapses them onto one component instead of emitting a second copy.
DASHBOARD_ICONS = {
    # Sidebar + program nav
    "PixelIconHome": "Map_Markers_Building_Home_House",
    "PixelIconGrid": "Software_File_Folder_Directory_Explorer",
    "PixelIconKey": "Tools_Crafting_Key_Unlock_1",
    "PixelIconChat": "Software_Speech_Bubble_Question_Mark_Quest_Return_Finished",
    "PixelIconDoc": "Tools_Crafting_Books_Manual_Documentation_Reading",
    "PixelIconGaps": "Software_Speech_Bubble_Exclaimation_Mark_Quest_New",
    "PixelIconUsers": "Travel_Person_Player_Character_Three_People_Multiplayer",
    "PixelIconPeople": "Travel_Person_People_Two",
    "PixelIconMacro": "Software_Clipbaord_List_File_Copy_Paste",
    "PixelIconBars": "Software_Statistics_Stats_Graphs_Bars",
    "PixelIconGauge": "Travel_Car_Driving_Speedometer_Graph",
    "PixelIconRadar": "Map_Markers_Scanner_Sweep_Radar_Detection",
    "PixelIconAlert": "Software_Warning_Sign_Triangle_Exclaimation_Mark_Error",
    "PixelIconSiren": "Travel_Bell_Alarm_Alert_Disaster",
    "PixelIconLog": "Tools_Crafting_Books_Scroll_Paper_Document",
    "PixelIconHourglass": "Software_Hourglass_Sand_Time_Wait",
    "PixelIconGear": "Software_Options_Settings_Cogwheel_Gear_Mechanics",
    # Top bar, breadcrumbs, rows, buttons
    "PixelIconSearch": "Software_Magnifier_Zoom_Looking_Magnifying_Glass",
    "PixelIconBell": "Travel_Bell_Notification_Ringing",
    "PixelIconChevronRight": "Arrows_Right_East",
    "PixelIconHand": "Travel_Person_Player_Character_Single",
    "PixelIconMoon": "Weather_Moon_Night_Crescent_Darkness_Mode_Twilight_Small",
    # The toggle's sun. Weather_Sunny_Warm_Hot_Summer_Season is an even 8-ray
    # star with a hollow middle, which at 16px is a gear — indistinguishable
    # from the Settings cogwheel next to it. This one is a round body with a
    # small hollow core and eight short free-standing rays, so the silhouette
    # differs from a cogwheel's even square teeth.
    "PixelIconSun": "Software_Monitor_Display_Brightness_Sun",
    "PixelIconBook": "Tools_Crafting_Books_Manual_Codex_Instructions_Tutorial_Documentation",
    "PixelIconExit": "Software_Exit_Quit_Doorway_Button",
    "PixelIconPlus": "Software_Signs_Maths_Plus_Addition_Bonus_Add_New",
    # Already present above for the onboarding; listed so this table is the whole
    # dashboard set. The merge keeps the onboarding component and sprite.
    "PixelIconCheck": "Software_Checkbox_Checkmarked_Yes_Done_Todo",
    "PixelIconSparkle": "RPG_Magic_Sparkles_Enchantment",
    "PixelIconClock": "Software_Clock_Time_Wait_2",
    "PixelIconInfo": "Software_Warning_Sign_Circle_Information_Help",
    "PixelIconArrowRight": "Arrows_Right_East",
}

ICON_GROUPS = (
    ("Onboarding wizard", ONBOARDING_ICONS),
    ("Dashboard", DASHBOARD_ICONS),
)

HEADER = '''// GENERATED by scripts/gen-pixel-icons.py from the "1-bit Pixel Icons" pack —
// edit the mapping there and re-run instead of editing this file. Shared by the
// onboarding wizard (app/wizard/_components/PixelIcons.tsx re-exports it) and
// the dashboard (app/_components/icons.tsx wraps these as Icon*).
// Only each 16x16 sprite's outline pixels are kept, drawn as crisp cells in
// currentColor, so icons take their context's text colour. Render at
// multiples of 16px (16, 32, 48) to keep every pixel square.
type IconProps = { size?: number; className?: string };

function PixelSvg({ size, className, d }: { size: number; className?: string; d: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      shapeRendering="crispEdges"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}
'''


def is_ink(pixel):
    red, green, blue, alpha = pixel
    return alpha > 127 and red + green + blue < 384


def sprite_path(png: Path) -> str:
    image = Image.open(png).convert("RGBA")
    width, height = image.size
    runs = []
    for y in range(height):
        x = 0
        while x < width:
            if not is_ink(image.getpixel((x, y))):
                x += 1
                continue
            start = x
            while x < width and is_ink(image.getpixel((x, y))):
                x += 1
            runs.append(f"M{start} {y}h{x - start}v1h-{x - start}z")
    return "".join(runs)


def constant_name(sprite: str) -> str:
    return f"SPRITE_{sprite.upper()}"


def merged_icons() -> tuple[dict, dict]:
    """Flatten the group tables into name -> sprite plus name -> owning group.

    The dashboard table deliberately repeats the five onboarding icons it shares
    (Check, Sparkle, Clock, Info, ArrowRight). The first table that names a
    component owns it, so a repeat only documents the mapping — and it must agree
    on the sprite, otherwise the emitted component would depend on table order.
    """
    merged: dict = {}
    owner: dict = {}
    for index, (_, group) in enumerate(ICON_GROUPS):
        for component, sprite in group.items():
            if component in merged and merged[component] != sprite:
                sys.exit(f"conflicting sprites for {component}: {merged[component]} vs {sprite}")
            if component not in merged:
                merged[component] = sprite
                owner[component] = index
    return merged, owner


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: gen-pixel-icons.py <pack>/Sprites")
    sprites = Path(sys.argv[1])
    icons, owner = merged_icons()

    outlines: dict = {}
    for sprite in dict.fromkeys(icons.values()):
        png = sprites / f"{sprite}.png"
        if not png.exists():
            sys.exit(f"missing sprite: {png}")
        outlines[sprite] = sprite_path(png)

    blocks = [
        HEADER,
        "// Sprite outlines — one constant per unique pack sprite, shared by every\n"
        "// component that draws the same mark.\n",
    ]
    for sprite, path in outlines.items():
        blocks.append(f"// {sprite}.png\nconst {constant_name(sprite)} =\n  \"{path}\";\n")

    for index, (title, group) in enumerate(ICON_GROUPS):
        blocks.append(f"// --- {title} ---")
        for component, sprite in group.items():
            if owner[component] != index:
                continue
            blocks.append(
                f"// {sprite}.png\n"
                f"export function {component}({{ size = 32, className }}: IconProps) {{\n"
                f"  return <PixelSvg size={{size}} className={{className}} d={{{constant_name(sprite)}}} />;\n"
                f"}}\n"
            )

    out = Path(__file__).resolve().parent.parent / "app/_components/PixelIcons.tsx"
    out.write_text("\n".join(blocks))
    print(f"wrote {out} ({len(icons)} icons, {len(outlines)} sprites)")


if __name__ == "__main__":
    main()
