Import-Module PSSailpoint

$forms = Search-BetaFormDefinitionsByTenant
forEach ($form in $forms.results) {
    Remove-BetaFormDefinition -FormDefinitionID $form.id
}