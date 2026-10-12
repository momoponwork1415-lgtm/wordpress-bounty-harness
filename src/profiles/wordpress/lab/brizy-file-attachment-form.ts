import type { DockerResult, Resources } from "./index.js";

type WordPressCommand = (
  resource: Resources,
  args: readonly string[],
) => Promise<DockerResult>;

const TARGET_SLUG = "brizy";

/** A generic form scenario needs a target adapter before provision. */
export function assertBrizyFileAttachmentFormTarget(
  fileAttachmentForm: boolean,
  targetSlug: string,
): void {
  if (fileAttachmentForm && targetSlug !== TARGET_SLUG)
    throw new Error("No file-attachment-form Lab adapter for this target");
}

/** Ordinary administrator setup after the public builder page has been seeded. */
export function brizyFileAttachmentFormSetupScript(): string {
  return String.raw`
$admin=get_user_by('login','harness-admin');
if(!$admin || !user_can($admin,'manage_options') || !in_array('brizy/brizy.php',(array)get_option('active_plugins',[]),true)) throw new RuntimeException('Form administrator is unavailable');
if(!class_exists('Brizy_Editor_Forms_FormManager') || !class_exists('Brizy_Editor_Forms_WordpressIntegration')) throw new RuntimeException('Form editor is unavailable');
wp_set_current_user($admin->ID);
$page=get_page_by_path('lab-builder-page',OBJECT,'page');
if(!$page || $page->post_status!=='publish' || !Brizy_Editor_Entity::isBrizyEnabled($page->ID)) throw new RuntimeException('Public builder page is unavailable');
$formId='labform_ordinary_attachment';
$form=(new Brizy_Editor_Forms_Form())->setId($formId);
$integration=(new Brizy_Editor_Forms_WordpressIntegration())->setCompleted(false);
if(!$form->addIntegration($integration)) throw new RuntimeException('Ordinary form integration is unavailable');
$forms=new Brizy_Editor_Forms_FormManager(Brizy_Editor_Project::get());
$forms->addForm($form);
$action=admin_url('admin-ajax.php?action='.Brizy_Editor::prefix(Brizy_Editor_Forms_Api::AJAX_SUBMIT_FORM));
$html='<section class="brz-section"><div class="brz-forms2"><h2>Ordinary Lab contact form</h2>'
 .'<form class="brz-form" method="post" enctype="multipart/form-data" action="'.esc_url($action).'" data-brz-form-id="'.esc_attr($formId).'">'
 .'<div class="brz-forms2__fields"><div class="brz-forms2__item"><label>Email<input name="email" type="email" data-brz-type="Email" data-brz-label="Email" required></label></div>'
 .'<div class="brz-forms2__item"><label>Attachment<input name="attachment[]" type="file" accept=".txt" data-brz-type="FileUpload" data-brz-label="Attachment"></label></div></div>'
 .'<button class="brz-btn" type="submit">Send</button></form></div></section>';
$editor=Brizy_Editor_Post::get($page->ID);
$sections=['rootClassNames'=>['brz-root__container'],'rootAttributes'=>[],
 'blocks'=>[['id'=>'lab-ordinary-form','html'=>$html,'assets'=>[]]]];
$manager=$editor->getCompiledSectionManager();
$manager->merge($sections);
$editor->setCompiledSections($manager->asJson());
$editor->set_compiler_version(BRIZY_EDITOR_VERSION);
$editor->set_needs_compile(false);
$editor->set_compiler(Brizy_Editor_Entity::COMPILER_BROWSER);
$editor->saveStorage();
$stored=(new Brizy_Editor_Forms_FormManager(Brizy_Editor_Project::get()))->getForm($formId);
$compiledHtml=$editor->getCompiledHtml();
if(!$stored || count($stored->getIntegrations())!==1 || $stored->getIntegrations()[0]->isCompleted() ||
 strpos($compiledHtml,'Ordinary Lab contact form')===false ||
 strpos($compiledHtml,'type="email"')===false || strpos($compiledHtml,'type="file"')===false)
 throw new RuntimeException('Public attachment form was not saved');
`;
}

/** Seed a harmless public form; sending a sample attachment is a later Lab action. */
export async function seedBrizyFileAttachmentForm(input: {
  readonly fileAttachmentForm: boolean;
  readonly targetSlug: string;
  readonly resource: Resources;
  readonly wp: WordPressCommand;
}): Promise<void> {
  if (!input.fileAttachmentForm) return;
  assertBrizyFileAttachmentFormTarget(
    input.fileAttachmentForm,
    input.targetSlug,
  );
  await input.wp(input.resource, [
    "eval",
    brizyFileAttachmentFormSetupScript(),
  ]);
}
