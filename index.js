
const request = require( 'request-promise' )
	, requestErrors = require( 'request-promise/errors' )
	, Bluebird = require( 'bluebird' )
	, moment = require( 'moment' )
	, _ = require( 'lodash' )
	, path = require( 'path' )
	, console = require( 'console' )
	, xpath = require( 'xpath.js' )
	, DOMParser = require( 'xmldom' ).DOMParser
	, Listr = require( 'listr' )
	, yazl = require( 'yazl' )
	, yargs = require( 'yargs' )
	, fs = Bluebird.promisifyAll( require( 'fs' ) )
	, enquirer = createEnquirer( require( 'enquirer' ) )
	, loadYaml = require( 'js-yaml' ).load
	;

class RuntimeError extends Error {}
Bluebird.longStackTraces();

function createEnquirer( Enquirer ) {
	let e = new Enquirer();
	e.register( 'list', require( 'prompt-list' ) );
	return e;
}

function urlTemplate( baseUrl, orientation, category, title ) {
	return `${ baseUrl }/${ orientation }/${ category }/${ title }/`;
}

function taskId( i, n ) {
	return _.padStart( i + 1, n.toString().length, '0' );
}

async function recursiveMkDir( argDir ) {
	var promise = Bluebird.resolve(),
		currentPath = "";
	_.each( argDir.split( path.sep ), function( argSplit, argIdx ) {
		currentPath = path.join( currentPath, argSplit + '\\' );
		if ( argIdx == 0 ) return; // Skip mkdir-ing the drive.
		promise = promise
			.return( currentPath )
			.then( fs.mkdirAsync )
			.catch( ( err ) => {
				// Output folder already existing is expected, it's not a problem.
				// Other types of error should be thrown.
				if ( err.code !== 'EEXIST' ) throw err;
			} );
	} );
	return promise;
}

async function downloadLink( baseUrl, link ) {
	let url = baseUrl + link;
	return request( url )
		.then( data => {
			return {
				href: link,
				name: path.basename( link ),
				content: data
			};
		} )
		.catch( requestErrors.StatusCodeError, err => { 
			if ( err.statusCode === 404 ) 
				throw new RuntimeError( 'Could not download link ' + url ); 
			throw err; 
		} );
}

async function askOrientation( orientations ) {
	return enquirer.ask( {
		name: 'orientation',
		message: 'Orientation?',
		type: 'list',
		choices: orientations
	} ).then( answers => answers.orientation );
}

async function askCategory( orientation, categories ) {
	let choices = [ '<' ].concat( categories );
	return enquirer.ask( {
		name: 'category',
		message: 'Category?',
		type: 'list',
		choices: choices
	} ).then( answers => answers.category );
}

async function askName( ) {
	return enquirer.ask( {
		name: 'name',
		message: 'Archive name? ( type \'<\' to abort )',
		type: 'input'
	} ).then( answers => answers.name );
}

async function askQuestions( yml, orientation, category, name ) {
	while ( !orientation || !category || !name ) {
		if ( !orientation || !_.includes( yml.orientations, orientation ) ) {
			orientation = await askOrientation( yml.orientations );
		} else if ( !category || !_.includes( yml.categories[ orientation ], category ) ) {
			category = await askCategory( orientation, yml.categories[ orientation ] );
			if ( category === '<' ) category = orientation = false;
		} else if ( !name ) {
			name = await askName( );
			if ( name === '<' ) name = category = false;
		}
	}

	console.info( '\n' );
	return [ orientation, category, name ];
}

async function main() {

	let yml = loadYaml( fs.readFileSync( 'nifty.yml', 'UTF-8' ) );

	let argv = yargs
		.option( 'orientation', {
			alias: 'o',
			describe: 'choose an orientation',
			choices: yml.orientations
		} )
		.option( 'category', {
			alias: 'c',
			describe: 'choose a category',
			choices: _.chain( yml.categories ).values().flatten().uniq().value()
		} )
		.option( 'name', {
			alias: 'n',
			describe: 'the name of the archive'
		} )
		.help()
		.argv;

	let [ orientation, category, name ] = await askQuestions( yml, argv.orientation, argv.category, argv.name );

	let url = urlTemplate( yml.baseUrl, orientation, category, name );

	let dataDir = path.join( __dirname, 'data' );
	let outputName = `${ name }.zip`;
	let outputPath = path.join( dataDir, outputName );

	await recursiveMkDir( dataDir );

	let tasks = [];

	tasks.push( { title: `Fetching ${ url }...`, task: ctx => {
		ctx.links = [];
		return request( url )
			.catch( requestErrors.StatusCodeError, err => { 
				if ( err.statusCode === 404 ) 
					throw new RuntimeError( 'Could not find archive at ' + url ); 
				throw err; 
			} )
			.then( html => new DOMParser( { errorHandler: _.noop } ).parseFromString( html ) )
			.then( dom => xpath( dom, '//table/descendant::a/@href' ) )
			.map( hrefAttr => hrefAttr.value )
			.map( ( href, i, l ) => {
				return {
					title: 	`${ taskId( i, l ) }. Fetching ${ href }...`,
					task: ctx => downloadLink( url, href ).then( value => { ctx.links[i] = value; return value; } )
				};
			} )
			.then( tasks => new Listr( tasks, { concurrent: true } ) );
	} } );

	tasks.push( { title: `Generating output...`, task: ( ctx, task ) => {
		let zipfile = new yazl.ZipFile();
		zipfile.outputStream.pipe( fs.createWriteStream( outputPath ) );
		_.each( ctx.links, ( link, i, l ) => {
			task.output = `Processing ${ link.name }...`;
			zipfile.addBuffer( new Buffer( link.content ), `${ taskId( i, l ) }-${ link.name }` );
		} );
		zipfile.addBuffer( new Buffer( `Downloaded from ${ url } on ${ moment().format( 'DD/MM/YYYY HH:mm' ) } using NiftyFetcher` ), 'DOWNLOADED' );
		zipfile.end();

		return zipfile.outputStream;
	} } );

	return Bluebird.resolve( new Listr( tasks, { collapse: false } ).run() )
		.then( () => console.info( '\nProcess complete. Output available as: ' + outputPath ) )
		.catch( RuntimeError, err => console.error( '\nProcess did not complete succesfully.' ) )
		.catch( err => console.error( '\nAn unexpected error occured: ' + err.stack ) );

}

main();
