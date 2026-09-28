# Design workflow

This runtime does not design for you; you write the HTML and CSS. Two common jobs are designing a new set of screens from scratch and cloning an existing page. Both use the same tools: add screens through the CLI, edit their files, and use `screenshot` to see and refine the result.

## Designing a screen set

For a request such as “create Tổng quan, Đơn hàng, and Chi tiết đơn hàng”:

1. Choose a project slug such as `sales-dashboard`; use the existing project when it matches the request. Decide the set of screens and give each a clear slug id, a Vietnamese display name, and a viewport that fits its content.
2. Establish shared design decisions first. Put common tokens — colors, spacing scale, font family, radius — in the project's `design-system.css`, which every screen already links. This keeps typography, spacing, and color consistent across the whole set instead of drifting per screen.
3. Add each screen with `screen add`, then read the generated `index.html` and `styles.css`. Build the UI with semantic HTML (`header`, `nav`, `main`, `section`, `article`, real headings and lists) and local CSS. Add only the JavaScript an interaction actually needs. Reference shared variables from `design-system.css` rather than repeating literal values.
4. Design for the whole set, not one screen in isolation: reuse the same header, navigation, buttons, and card styles so the screens read as one product. Give key, reusable elements a stable `data-design-id` so later selection and edits map cleanly.
5. Verify each screen visually. Run `screenshot <screen-id> --project <id> --json`, open the PNG, and judge layout, readability, alignment, and spacing — not just whether it renders. Fix what looks off and capture again. Do a few passes; do not treat a clean render as a finished design.
6. Keep content and controls in the relevant screen's files. A request to change the Overview sidebar edits Overview only, unless the user also asks to change shared tokens in `design-system.css`.
7. Let the watcher refresh the changed preview. The canvas preserves each project's frame positions and zoom while source files change, so arranging screens on the canvas is safe during edits.

## Cloning a UI page

When the user asks to clone or copy a page's UI, aim to match it closely — layout, spacing, colors, and typography — not just its general feel. Work from the full-page screenshot as the source of truth:

1. Confirm the URL, then `reference fetch <url> --project <id> --json`. Note `imagePath` (full-page screenshot) and the extracted title/headings/links.
2. Open the screenshot with your image-reading tool and study it top to bottom: overall structure and column widths, section order, background and accent colors, font sizes and weights, borders, spacing, and every distinctive element (banners, badges, ribbons, dotted dividers, footer blocks).
3. Recreate one screen of static HTML/CSS that reproduces the same structure and visual details. Use the real text you extracted where it is factual page content (titles, labels, metadata), and placeholders for images you cannot fetch.
4. Run `screenshot <screen-id> --project <id> --json`, open the result, and compare it side by side with the reference screenshot. List concrete differences (a missing banner, wrong accent color, misaligned column, different font size) and fix them.
5. Repeat step 4 until the clone matches. Stop after a few passes and report the remaining differences you could not close (for example, images that require the real assets).

Boundary: cloning a page's visual layout for learning or internal design work is fine, but do not republish the source's copyrighted content or assets. Replace real images and any copyrighted text with placeholders or the user's own content, and keep the result as local static files.

## When something fails

When an operation fails, leave existing design source intact. Report the failed action and error code, then offer the command that will retry after the user fixes the condition. Do not stop a running runtime unless the user asks to stop it.
